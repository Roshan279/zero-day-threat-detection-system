"""
anomaly_detector.py
ML-based anomaly scoring: Isolation Forest + KMeans clustering + historical
baseline deviation. Results are written back into the events table.

UPGRADES vs previous version:
  - Model persistence: IF model, KMeans, and StandardScaler saved to
    models/ directory via joblib. Reloaded on startup. Only retrains when
    >500 new events have accumulated OR 24 hours have passed since last
    train. Eliminates the cold-start retraining on every scan.
  - Weighted baseline update: recent data = 30% weight, historical = 70%.
    Prevents adversarial poisoning — an attacker slowly shifting behaviour
    over days cannot quickly move the baseline.
  - cluster_id + cluster_label written to dedicated DB columns (not just
    buried inside raw_data JSON) — required by the new database.py schema
    and used by the replay timeline and entity graph.
  - score_single_event(): scores one event instantly using the loaded
    model without retraining. Called by the real-time watchdog in main.py
    for <1s alert latency on new events.
  - All previous fixes retained: batched executemany(), dual-hash,
    feature importance, typed exceptions.
"""

import json
import hashlib
import logging
import os
import time
import numpy as np
from datetime import datetime
from pathlib import Path
from sklearn.ensemble import IsolationForest
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

try:
    import joblib
    _JOBLIB_AVAILABLE = True
except ImportError:
    _JOBLIB_AVAILABLE = False
    logging.getLogger(__name__).warning(
        "[Anomaly] joblib not available — model persistence disabled. "
        "Install with: pip install joblib"
    )

from database import get_connection

logger = logging.getLogger(__name__)

# ── Model storage path ────────────────────────────────────────
MODELS_DIR = Path("models")
MODELS_DIR.mkdir(exist_ok=True)

IF_MODEL_PATH      = MODELS_DIR / "isolation_forest.joblib"
KMEANS_MODEL_PATH  = MODELS_DIR / "kmeans.joblib"
SCALER_MODEL_PATH  = MODELS_DIR / "scaler.joblib"
MODEL_META_PATH    = MODELS_DIR / "model_meta.json"

# ── Retraining policy ─────────────────────────────────────────
RETRAIN_MIN_NEW_EVENTS = 500    # retrain after this many new events
RETRAIN_MAX_AGE_HOURS  = 24     # retrain after this many hours regardless

# ── In-memory model cache ─────────────────────────────────────
_cached_model: dict = {
    "if":      None,   # IsolationForest
    "kmeans":  None,   # KMeans
    "scaler":  None,   # StandardScaler
    "trained_on": 0,   # event count at last train
    "trained_at": 0.0, # unix timestamp of last train
}


# ─────────────────────────────────────────────────────────────
# FEATURE METADATA
# ─────────────────────────────────────────────────────────────

FEATURE_NAMES = ["hour_of_day", "event_id_mod", "log_source", "event_type_risk"]

FEATURE_LABELS = {
    "hour_of_day":     "Time of Day",
    "event_id_mod":    "Event ID Pattern",
    "log_source":      "Log Source",
    "event_type_risk": "Event Type Risk",
}

FEATURE_DESCRIPTIONS = {
    "hour_of_day":     "How unusual the time of this event is (e.g. 3AM logins score higher)",
    "event_id_mod":    "How rare this specific Event ID is in the log baseline",
    "log_source":      "Which log channel this came from (Security > System > Application)",
    "event_type_risk": "How risky the event classification is (AUDIT_FAILURE > ERROR > WARNING)",
}

CLUSTER_LABELS = {
    "high_frequency_audit":  "Brute Force Pattern",
    "credential_activity":   "Credential Access Pattern",
    "privilege_change":      "Privilege Escalation Pattern",
    "service_manipulation":  "Persistence Pattern",
    "application_anomaly":   "Data Exfiltration Pattern",
    "normal_system":         "Normal System Activity",
    "unknown":               "Unknown Pattern",
}

EVENT_ID_CLUSTERS = {
    frozenset([4625, 4740]): "high_frequency_audit",
    frozenset([4625]):       "high_frequency_audit",
    frozenset([4740]):       "high_frequency_audit",
    frozenset([4648, 5379]): "credential_activity",
    frozenset([5379]):       "credential_activity",
    frozenset([4648]):       "credential_activity",
    frozenset([4720, 4726, 4624]): "privilege_change",
    frozenset([4720]):       "privilege_change",
    frozenset([4726]):       "privilege_change",
    frozenset([7045, 7040]): "service_manipulation",
    frozenset([7045]):       "service_manipulation",
    frozenset([1000, 1001]): "application_anomaly",
    frozenset([1001]):       "application_anomaly",
}


def get_cluster_label(event_ids: set) -> str:
    best, best_n = None, 0
    for key, label in EVENT_ID_CLUSTERS.items():
        n = len(key & event_ids)
        if n > best_n:
            best_n = n
            best   = label
    return best or "normal_system"


# ─────────────────────────────────────────────────────────────
# DUAL HASHING
# ─────────────────────────────────────────────────────────────

def dual_hash(raw_str: str, normalized_str: str) -> dict:
    """
    Hash the raw log packet AND the normalised object separately.
    Any mutation in the normalisation pipeline is detectable.
    """
    return {
        "raw_hash":        hashlib.sha256(raw_str.encode()).hexdigest(),
        "normalized_hash": hashlib.sha256(normalized_str.encode()).hexdigest(),
        "combined_hash":   hashlib.sha256((raw_str + normalized_str).encode()).hexdigest(),
    }


# ─────────────────────────────────────────────────────────────
# FEATURE EXTRACTION
# ─────────────────────────────────────────────────────────────

def extract_features(events: list) -> list:
    """Extract 4-dimensional feature vector from each event."""
    rows = []
    for e in events:
        event_id = 0
        etype    = ""
        try:
            raw      = json.loads(e["raw_data"])
            event_id = int(raw.get("EventID") or 0)
            etype    = raw.get("EventType", "")
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            logger.debug("Feature extract error for event %s: %s", e.get("id"), exc)

        ts   = e.get("timestamp", "")
        hour = 12
        try:
            dt   = datetime.fromisoformat(ts.replace("T", " ").split(".")[0])
            hour = dt.hour
        except (ValueError, AttributeError):
            pass

        src_enc  = {"Security": 0, "System": 1, "Application": 2}.get(
            e.get("source", ""), 3)
        type_enc = {"AUDIT_FAILURE": 3, "ERROR": 2, "WARNING": 1,
                    "AUDIT_SUCCESS": 0, "INFORMATION": 0}.get(etype, 0)

        rows.append([float(hour), float(event_id % 1000),
                     float(src_enc), float(type_enc)])
    return rows


def extract_single_feature(event: dict) -> np.ndarray:
    """Extract feature vector for a single event. Used by score_single_event()."""
    return np.array(extract_features([event])[0], dtype=float).reshape(1, -1)


# ─────────────────────────────────────────────────────────────
# HISTORICAL BASELINE  (weighted — adversarial poisoning protection)
# ─────────────────────────────────────────────────────────────

def load_baseline() -> dict:
    """Load the stored feature mean/std baseline from the database."""
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM system_config WHERE key = 'feature_baseline'")
    row = cursor.fetchone()
    conn.close()
    if row:
        try:
            return json.loads(row["value"])
        except (json.JSONDecodeError, TypeError) as exc:
            logger.warning("Could not parse stored baseline: %s", exc)
    return {}


def save_baseline(means: list, stds: list, n_samples: int):
    """Persist the current feature baseline."""
    payload = {
        "means":      means,
        "stds":       stds,
        "n_samples":  n_samples,
        "updated_at": datetime.now().isoformat(),
    }
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT OR REPLACE INTO system_config (key, value, updated_at)
        VALUES ('feature_baseline', ?, CURRENT_TIMESTAMP)
    """, (json.dumps(payload),))
    conn.commit()
    conn.close()


def update_weighted_baseline(X: np.ndarray, baseline: dict) -> dict:
    """
    Update the baseline using a 70/30 weighted average.

    Historical data (70%) outweighs recent data (30%) so an attacker
    who slowly shifts their behaviour over days cannot quickly poison
    the anomaly detector's reference point.

    On first run (no baseline), bootstraps from the current data.
    """
    if not baseline or "means" not in baseline:
        means = X.mean(axis=0).tolist()
        stds  = X.std(axis=0).tolist()
        save_baseline(means, stds, len(X))
        logger.info("[Baseline] Bootstrapped from %d events.", len(X))
        return {"means": means, "stds": stds, "n_samples": len(X)}

    old_n = baseline.get("n_samples", len(X))

    # 70% historical weight, 30% recent — fixed regardless of sample sizes
    # This is the adversarial poisoning protection:
    # even a flood of crafted events only shifts the baseline by 30%
    HISTORICAL_WEIGHT = 0.70
    RECENT_WEIGHT     = 0.30

    new_means = (
        HISTORICAL_WEIGHT * np.array(baseline["means"]) +
        RECENT_WEIGHT     * X.mean(axis=0)
    )
    new_stds = (
        HISTORICAL_WEIGHT * np.array(baseline["stds"]) +
        RECENT_WEIGHT     * X.std(axis=0)
    )

    save_baseline(new_means.tolist(), new_stds.tolist(), old_n + len(X))
    logger.info(
        "[Baseline] Updated (70%% historical / 30%% recent) — "
        "total samples: %d.", old_n + len(X)
    )
    return {"means": new_means.tolist(), "stds": new_stds.tolist(),
            "n_samples": old_n + len(X)}


def baseline_deviation_score(X: np.ndarray, baseline: dict) -> np.ndarray:
    """Per-sample deviation from historical baseline, normalised 0–1."""
    if not baseline or "means" not in baseline:
        return np.zeros(len(X))

    means = np.array(baseline["means"])
    stds  = np.array(baseline["stds"])
    stds  = np.where(stds < 1e-6, 1.0, stds)

    deviations = np.abs(X - means) / stds
    mean_dev   = deviations.mean(axis=1)

    mn, mx = mean_dev.min(), mean_dev.max()
    if mx > mn:
        return (mean_dev - mn) / (mx - mn)
    return np.zeros(len(X))


# ─────────────────────────────────────────────────────────────
# MODEL PERSISTENCE
# ─────────────────────────────────────────────────────────────

def _load_model_meta() -> dict:
    """Load metadata about the last saved model."""
    try:
        if MODEL_META_PATH.exists():
            with open(MODEL_META_PATH) as f:
                return json.load(f)
    except Exception as e:
        logger.warning("[Models] Could not load model meta: %s", e)
    return {}


def _save_model_meta(n_events: int):
    """Save metadata about the current model."""
    try:
        meta = {
            "trained_on":  n_events,
            "trained_at":  time.time(),
            "trained_at_iso": datetime.now().isoformat(),
        }
        with open(MODEL_META_PATH, "w") as f:
            json.dump(meta, f, indent=2)
    except Exception as e:
        logger.warning("[Models] Could not save model meta: %s", e)


def _should_retrain(n_current_events: int) -> bool:
    """
    Decide whether to retrain based on:
      1. No saved model exists
      2. More than RETRAIN_MIN_NEW_EVENTS new events since last train
      3. More than RETRAIN_MAX_AGE_HOURS hours since last train
    """
    if not _JOBLIB_AVAILABLE:
        return True  # always retrain if joblib unavailable

    if not IF_MODEL_PATH.exists():
        logger.info("[Models] No saved model found — will train fresh.")
        return True

    meta = _load_model_meta()
    if not meta:
        return True

    trained_on = meta.get("trained_on", 0)
    trained_at = meta.get("trained_at", 0.0)

    new_events_since = n_current_events - trained_on
    hours_since      = (time.time() - trained_at) / 3600

    if new_events_since >= RETRAIN_MIN_NEW_EVENTS:
        logger.info(
            "[Models] %d new events since last train — retraining.",
            new_events_since,
        )
        return True

    if hours_since >= RETRAIN_MAX_AGE_HOURS:
        logger.info(
            "[Models] %.1f hours since last train — retraining.",
            hours_since,
        )
        return True

    logger.info(
        "[Models] Using cached model "
        "(%d new events, %.1fh since train — below thresholds).",
        new_events_since, hours_since,
    )
    return False


def _save_models(clf: IsolationForest, kmeans: KMeans,
                 scaler: StandardScaler, n_events: int):
    """Persist trained models to disk using joblib."""
    if not _JOBLIB_AVAILABLE:
        return
    try:
        joblib.dump(clf,    IF_MODEL_PATH)
        joblib.dump(kmeans, KMEANS_MODEL_PATH)
        joblib.dump(scaler, SCALER_MODEL_PATH)
        _save_model_meta(n_events)
        logger.info("[Models] Saved IF + KMeans + Scaler to %s/", MODELS_DIR)
    except Exception as e:
        logger.warning("[Models] Could not save models: %s", e)


def _load_models() -> bool:
    """
    Load saved models into the in-memory cache.
    Returns True if all models loaded successfully.
    """
    global _cached_model
    if not _JOBLIB_AVAILABLE:
        return False

    try:
        if (IF_MODEL_PATH.exists() and
                KMEANS_MODEL_PATH.exists() and
                SCALER_MODEL_PATH.exists()):

            _cached_model["if"]     = joblib.load(IF_MODEL_PATH)
            _cached_model["kmeans"] = joblib.load(KMEANS_MODEL_PATH)
            _cached_model["scaler"] = joblib.load(SCALER_MODEL_PATH)

            meta = _load_model_meta()
            _cached_model["trained_on"] = meta.get("trained_on", 0)
            _cached_model["trained_at"] = meta.get("trained_at", 0.0)

            logger.info(
                "[Models] Loaded cached IF + KMeans + Scaler "
                "(trained on %d events).",
                _cached_model["trained_on"],
            )
            return True
    except Exception as e:
        logger.warning("[Models] Could not load saved models: %s", e)

    return False


def load_models_on_startup():
    """Called once from main.py on startup to pre-load models."""
    loaded = _load_models()
    if not loaded:
        logger.info(
            "[Models] No cached models — will train on first scan."
        )


# ─────────────────────────────────────────────────────────────
# SCORING HELPERS
# ─────────────────────────────────────────────────────────────

def assign_tier(score: float) -> int:
    if score > 0.85:
        return 4
    if score > 0.65:
        return 3
    if score > 0.40:
        return 2
    return 1


def compute_feature_importance(x_row: np.ndarray, baseline: dict) -> list:
    """Per-feature contribution as a % of total anomaly signal."""
    if baseline and "means" in baseline and "stds" in baseline:
        means        = np.array(baseline["means"])
        stds         = np.array(baseline["stds"])
        stds         = np.where(stds < 1e-6, 1.0, stds)
        raw_contribs = np.abs(x_row - means) / stds
    else:
        raw_contribs = np.abs(x_row)

    total = raw_contribs.sum()
    pcts  = (raw_contribs / total * 100).tolist() if total > 0 else [25.0] * 4

    result = []
    for i, name in enumerate(FEATURE_NAMES):
        result.append({
            "feature":     name,
            "label":       FEATURE_LABELS[name],
            "description": FEATURE_DESCRIPTIONS[name],
            "value":       float(x_row[i]),
            "pct":         round(pcts[i], 1),
        })
    result.sort(key=lambda d: -d["pct"])
    return result


# ─────────────────────────────────────────────────────────────
# SINGLE EVENT SCORING  (real-time watcher path)
# ─────────────────────────────────────────────────────────────

def score_single_event(event: dict) -> dict:
    """
    Score a single event using the in-memory cached model.
    Called by the real-time watchdog in main.py for instant scoring
    without triggering a full retrain.

    Returns:
        {
          anomaly_score: float (0–1),
          threat_tier:   int (1–4),
          cluster_id:    int,
          cluster_label: str,
        }

    Falls back to heuristic scoring if no model is loaded yet.
    """
    global _cached_model

    # Ensure models are loaded
    if _cached_model["if"] is None:
        _load_models()

    x = extract_single_feature(event)
    baseline = load_baseline()

    # ── Heuristic fallback if still no model ────────────────
    if _cached_model["if"] is None:
        raw = {}
        try:
            raw = json.loads(event.get("raw_data", "{}"))
        except (json.JSONDecodeError, TypeError):
            pass

        hour      = x[0][0]
        etype     = raw.get("EventType", "")
        risk_hour = 1.0 if (hour >= 22 or hour <= 5) else 0.3
        risk_type = {"AUDIT_FAILURE": 0.9, "ERROR": 0.6}.get(etype, 0.2)
        score     = (risk_hour * 0.4 + risk_type * 0.6)
        return {
            "anomaly_score": round(score, 4),
            "threat_tier":   assign_tier(score),
            "cluster_id":    -1,
            "cluster_label": "",
        }

    # ── IF score ─────────────────────────────────────────────
    try:
        decision  = _cached_model["if"].decision_function(x)[0]
        # Normalise using the model's training range stored in meta
        # For a single point we use a fixed normalisation window
        if_score  = max(0.0, min(1.0, 1.0 - (decision + 0.5)))
    except Exception as e:
        logger.warning("[Anomaly] IF scoring error: %s", e)
        if_score = 0.5

    # ── Baseline deviation ───────────────────────────────────
    baseline_score = float(baseline_deviation_score(x, baseline)[0])

    # ── Combined ─────────────────────────────────────────────
    score = 0.70 * if_score + 0.30 * baseline_score
    score = max(0.0, min(1.0, score))

    # ── Cluster assignment ───────────────────────────────────
    cid   = -1
    blbl  = ""
    try:
        x_scaled = _cached_model["scaler"].transform(x)
        cid      = int(_cached_model["kmeans"].predict(x_scaled)[0])

        # Determine cluster label from the event's own EventID
        raw = {}
        try:
            raw = json.loads(event.get("raw_data", "{}"))
        except (json.JSONDecodeError, TypeError):
            pass
        eid   = raw.get("EventID")
        eids  = {int(eid)} if eid else set()
        behav = get_cluster_label(eids)
        blbl  = CLUSTER_LABELS.get(behav, "")
    except Exception as e:
        logger.debug("[Anomaly] Cluster predict error: %s", e)

    return {
        "anomaly_score": round(score, 4),
        "threat_tier":   assign_tier(score),
        "cluster_id":    cid,
        "cluster_label": blbl,
    }


# ─────────────────────────────────────────────────────────────
# MAIN DETECTION RUN  (batch — manual scan + scheduled)
# ─────────────────────────────────────────────────────────────

def run_anomaly_detection():
    """
    Score all recent events with:
      - Isolation Forest (70% weight)  — retrained only when needed
      - Historical baseline deviation (30% weight)  — weighted 70/30
      - KMeans cluster labelling       — retrained with IF
      - Per-event feature importance
      - Dual-hash integrity stamps
      - cluster_id + cluster_label written to dedicated DB columns

    All DB writes are batched into a single executemany() call.
    """
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM events ORDER BY id DESC LIMIT 500")
    events = [dict(e) for e in cursor.fetchall()]
    conn.close()

    if len(events) < 2:
        logger.info("[Anomaly] Not enough events (need ≥ 2, got %d).", len(events))
        return

    features = extract_features(events)
    X        = np.array(features, dtype=float)

    # ── Weighted baseline (adversarial poisoning protection) ─
    baseline = load_baseline()
    baseline = update_weighted_baseline(X, baseline)

    # ── Decide whether to retrain ────────────────────────────
    do_retrain = _should_retrain(len(events))

    if do_retrain or _cached_model["if"] is None:
        # ── Train Isolation Forest ───────────────────────────
        clf = IsolationForest(
            contamination=0.2,
            random_state=42,
            n_estimators=100,
        )
        clf.fit(X)

        # ── Train KMeans ─────────────────────────────────────
        n_clusters = min(6, max(2, len(events)))
        scaler     = StandardScaler()
        X_scaled   = scaler.fit_transform(X)
        kmeans     = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
        kmeans.fit(X_scaled)

        # ── Save to disk ─────────────────────────────────────
        _save_models(clf, kmeans, scaler, len(events))

        # ── Update in-memory cache ───────────────────────────
        _cached_model["if"]         = clf
        _cached_model["kmeans"]     = kmeans
        _cached_model["scaler"]     = scaler
        _cached_model["trained_on"] = len(events)
        _cached_model["trained_at"] = time.time()

        logger.info(
            "[Anomaly] Models retrained on %d events (KMeans k=%d).",
            len(events), n_clusters,
        )
    else:
        # Use cached models
        clf    = _cached_model["if"]
        kmeans = _cached_model["kmeans"]
        scaler = _cached_model["scaler"]
        n_clusters = kmeans.n_clusters

    # ── Score with IF ────────────────────────────────────────
    decision  = clf.decision_function(X)
    mn, mx    = decision.min(), decision.max()
    if_scores = (
        1 - (decision - mn) / (mx - mn) if mx != mn
        else np.zeros(len(decision))
    )

    # ── Baseline deviation scores ────────────────────────────
    baseline_scores = baseline_deviation_score(X, baseline)

    # ── Combined score (70 IF / 30 baseline) ────────────────
    combined_scores = 0.70 * if_scores + 0.30 * baseline_scores

    # ── KMeans cluster assignments ───────────────────────────
    X_scaled  = scaler.transform(X)
    km_labels = kmeans.predict(X_scaled)

    cluster_eids: dict[int, set] = {}
    for i, ev in enumerate(events):
        cid = int(km_labels[i])
        cluster_eids.setdefault(cid, set())
        try:
            raw = json.loads(ev["raw_data"])
            eid = raw.get("EventID")
            if eid:
                cluster_eids[cid].add(int(eid))
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    cluster_behavior = {
        cid: get_cluster_label(eids) for cid, eids in cluster_eids.items()
    }

    # ── Build batch update payload ───────────────────────────
    batch: list[tuple] = []

    for i, ev in enumerate(events):
        score = float(combined_scores[i])
        tier  = assign_tier(score)
        cid   = int(km_labels[i])
        behav = cluster_behavior.get(cid, "normal_system")
        b_lbl = CLUSTER_LABELS.get(behav, "Unknown Pattern")
        fi    = compute_feature_importance(X[i], baseline)

        raw_orig = ev.get("raw_data", "")
        raw_obj  = {}
        try:
            raw_obj = json.loads(raw_orig)
        except (json.JSONDecodeError, TypeError) as exc:
            logger.debug("raw_data parse error for event %s: %s", ev.get("id"), exc)

        normalized_obj = {
            "event_id":      raw_obj.get("EventID"),
            "source":        ev.get("source"),
            "event_type":    raw_obj.get("EventType"),
            "timestamp":     ev.get("timestamp"),
            "anomaly_score": score,
            "threat_tier":   tier,
        }
        normalized_str = json.dumps(normalized_obj, sort_keys=True)
        hashes         = dual_hash(raw_orig, normalized_str)

        raw_obj.update({
            "cluster_id":         cid,
            "behavior":           behav,
            "behavior_label":     b_lbl,
            "feature_importance": fi,
            "if_score":           round(float(if_scores[i]),       4),
            "baseline_score":     round(float(baseline_scores[i]), 4),
            "raw_hash":           hashes["raw_hash"],
            "normalized_hash":    hashes["normalized_hash"],
            "combined_hash":      hashes["combined_hash"],
        })

        try:
            updated_raw = json.dumps(raw_obj)
        except (TypeError, ValueError) as exc:
            logger.warning("Serialise error for event %s: %s", ev.get("id"), exc)
            updated_raw = raw_orig

        # Include cluster_id + cluster_label for the dedicated DB columns
        batch.append((score, tier, updated_raw, cid, b_lbl, ev["id"]))

    # ── Single batched write — now also updates cluster columns ─
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.executemany("""
        UPDATE events
        SET anomaly_score = ?,
            threat_tier   = ?,
            raw_data      = ?,
            cluster_id    = ?,
            cluster_label = ?
        WHERE id = ?
    """, batch)
    conn.commit()
    conn.close()

    logger.info(
        "[Anomaly] Scored %d events — IF + baseline(weighted) + "
        "KMeans(%d) + feature importance + dual hash. Retrained: %s.",
        len(events), n_clusters, do_retrain,
    )
    print(
        f"[Anomaly] Scored {len(events)} events — "
        f"KMeans({n_clusters}), retrained={do_retrain}."
    )


if __name__ == "__main__":
    run_anomaly_detection()
    print("Done.")