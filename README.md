Zero day threat detection system
AI-Powered Windows Forensic Detection Platform

================================================================
OVERVIEW
================================================================

Zero day threat detection system is a real-time security monitoring and forensic
analysis platform for Windows. It watches the Windows Event Log,
scores every event with a machine-learning anomaly pipeline,
chains every record into a tamper-evident SHA-256 ledger, and
lets you investigate the results through a React dashboard with
an AI detective persona ("Luffy") that explains what happened in
plain language -- and can take real defensive action (blocking
accounts/IPs) when you approve it.

It is built as a two-tier app:

- Backend: Python / FastAPI service that collects Windows Event
  Log data, runs anomaly detection (Isolation Forest + KMeans),
  maintains a hash-chained forensic database, talks to Groq's
  LLM API for the "Luffy" detective persona, executes active
  response actions, and generates PDF reports.

- Frontend: React 19 + Vite single-page app that visualizes
  events, entities, ML feature importance, response simulation,
  and an attack replay timeline, with an animated Luffy character
  overlay that reacts to threat state.

WARNING: This project reads live Windows Security/System event
logs and can disable user accounts and add Windows Firewall
rules. Only run it on a machine/VM you own or are authorized to
monitor, and read the "ACTIVE RESPONSE AND SAFETY" section below
before enabling non-dry-run mode.

================================================================
TABLE OF CONTENTS
================================================================

1.  Features
2.  Architecture
3.  Project Structure
4.  Prerequisites
5.  Installation
6.  Configuration
7.  Running the App
8.  Backend Modules
9.  API Reference
10. Frontend Tabs
11. Machine Learning Pipeline
12. Forensic Integrity Chain
13. Active Response and Safety
14. AI Detective (Luffy) and Data Privacy
15. Demo Mode
16. PDF Reports
17. Database Schema
18. Troubleshooting
19. Roadmap Ideas
20. License

================================================================
1. FEATURES
================================================================

- Real-time event ingestion: subscribes to the Windows Event Log
  via EvtSubscribe, scoring and alerting on new events in under a
  second (with a 60-second polling scan as a backup/health-check).

- ML anomaly detection: Isolation Forest anomaly scoring + KMeans
  behavioral clustering + historical baseline deviation, producing
  a 1-4 threat tier per event with per-feature importance
  breakdowns.

- Tamper-evident forensic log: every event is SHA-256 chained to
  the previous event (event_hash = SHA256(raw_data + timestamp +
  source + prev_hash)), so deletion, modification, or reordering
  of records is detectable.

- AI detective persona ("Luffy"): a Groq/Llama-backed chat
  assistant that narrates case files, explains individual events,
  answers free-form questions about the investigation, and can
  drive the UI itself (switch tabs, run a scan, block an entity)
  via structured commands.

- Active response: real Windows account disable (net user
  /active:no) and firewall IP blocking (netsh advfirewall), with
  a whitelist, privilege checks, dry-run safety mode, and a
  permanent audit trail. Includes an unblock/reversal path.

- Entity correlation graph: groups events by source entity
  (user/host) to show attack progression across accounts and
  machines.

- Attack replay timeline: step through a chronological
  reconstruction of an incident with enriched context -- what
  Windows did, what control was missing, and why the event is
  forensically significant.

- Response simulation: maps each event's threat tier to a
  documented tiered-autonomy response policy (log-only -> analyst
  alert -> conditional auto-response -> full isolation).

- PDF report generation: one-click "Technical" (detailed,
  analyst-facing) and "Management" (executive summary) forensic
  reports via ReportLab.

- Demo mode: injects a realistic, multi-phase synthetic attack
  (brute force -> lockout -> credential access -> persistence ->
  log clearing) so the whole platform can be demonstrated without
  a real incident.

- PII-safe AI calls: all event data is sanitized (IPs redacted,
  usernames pseudonymised) and wrapped against prompt injection
  before being sent to the Groq API.

- Cross-platform dev fallback: the Windows-only pieces
  (pywin32/win32evtlog) degrade gracefully on non-Windows systems
  so the API and frontend can still run for development (with
  demo mode standing in for live log collection).

================================================================
2. ARCHITECTURE
================================================================

  React + Vite Frontend  <--- HTTP (axios/JSON) --->  FastAPI Backend
  (localhost:5173)                                    (localhost:8000)

  The backend, in turn, talks to three things:

  - Windows Event Log (EvtSubscribe realtime + batch polling
    fallback) -> feeds anomaly_detector.py (Isolation Forest +
    KMeans, models persisted via joblib)

  - SQLite (forensic.db) storing events / case_files /
    chat_history / flagged_entities / response_audit, verified
    by integrity.py (SHA-256 hash chain)

  - Groq LLM API (Luffy persona, sanitized data only)

  response_executor.py issues real Windows actions (net user /
  netsh firewall), dry-run capable.

  Request flow for a new Windows event:
  1. log_collector.py receives the event via the real-time
     EvtSubscribe callback (or a periodic batch scan).
  2. The event is hashed and chained (integrity.py) and inserted
     into SQLite.
  3. Its ID is pushed onto an in-memory queue.
  4. main.py's watchdog thread drains the queue and calls
     anomaly_detector.score_single_event() for near-instant
     scoring.
  5. If the resulting threat tier is >= 3, it's surfaced to the
     frontend via /watchdog polling and can trigger the Luffy
     overlay's alert state.
  6. The analyst (or Luffy, on approval) can call /block-entity
     to take real action through response_executor.py.

================================================================
3. PROJECT STRUCTURE
================================================================

DetectiveLuffy-main/
  backend/
    main.py                 - FastAPI app, all REST endpoints,
                               watchdog thread
    database.py              - SQLite connection + schema +
                               migrations
    log_collector.py         - Windows Event Log collection
                               (real-time + batch)
    anomaly_detector.py       - ML scoring: Isolation Forest,
                               KMeans, feature importance
    integrity.py              - SHA-256 hash chain compute +
                               verify
    detective.py               - Groq/Llama "Luffy" persona: case
                               files, chat, event analysis
    sanitizer.py               - PII redaction + prompt-injection
                               hardening for AI calls
    response_executor.py        - Real Windows active response
                               (account/IP block, audit log)
    report_generator.py          - ReportLab PDF generation
                               (technical + management reports)
    demo_mode.py                  - Synthetic multi-phase attack
                               injection for demos
    models/                        - Persisted ML models (joblib)
                               + metadata
      isolation_forest.joblib
      kmeans.joblib
      scaler.joblib
      model_meta.json
  frontend/
    src/
      App.jsx               - Main app shell, tabs, state, chat,
                               command dispatch
      App.css / index.css   - Styling
      EntityGraph.jsx        - Entity correlation graph view
      Featureimportance.jsx   - ML feature importance charts
      Responsesimulation.jsx   - Tiered response policy
                               simulation view
      ReplayTimeline.jsx        - Chronological attack replay
                               view
      LuffyOverlay.jsx            - Animated Luffy character/mood
                               overlay
      Humanlog.js                  - Human-readable event/log
                               formatting helpers
      sanitize.js                   - Frontend-side output
                               sanitization helpers
    public/aria/                     - Luffy mood sprite images
                               (idle/alert/angry/thinking/happy/goofy)
    package.json
    vite.config.js

================================================================
4. PREREQUISITES
================================================================

Required for the full experience (Windows):
- Windows 10/11
- Python 3.10+ (3.11 recommended)
- Node.js 18+ and npm
- Administrator privileges (needed to read the Security event log
  and to actually execute account/firewall block actions --
  without it the app runs in a forced dry-run/degraded mode)
- A free Groq API key (https://console.groq.com/) for the Luffy
  chat persona (optional -- the rest of the platform works
  without it, but chat/case-file endpoints will fail)

For development on macOS/Linux: the FastAPI backend, database, ML
pipeline, and frontend all run fine -- log_collector.py detects
the missing pywin32/win32evtlog modules and disables live Windows
log collection, so use Demo Mode (section 15) to populate data.

================================================================
5. INSTALLATION
================================================================

--- Backend Setup ---

cd DetectiveLuffy-main/backend

Create and activate a virtual environment:
  python -m venv venv
  venv\Scripts\activate        (Windows)
  source venv/bin/activate     (macOS/Linux)

Install dependencies:
  pip install fastapi uvicorn pydantic
  pip install scikit-learn numpy joblib
  pip install groq python-dotenv
  pip install reportlab
  pip install pywin32              (Windows only -- enables live
                                     event log collection)

Note: there is no requirements.txt bundled with this checkout --
the packages above are the complete set imported across
backend/*.py. Consider running "pip freeze > requirements.txt"
after your first successful install to pin versions for future
setups.

Create a .env file inside backend/ (see section 6, Configuration):
  GROQ_API_KEY=your_groq_api_key_here

--- Frontend Setup ---

cd DetectiveLuffy-main/frontend
npm install

Dependencies installed: react 19, react-dom 19, axios, d3,
recharts, tailwindcss 4 (+ @tailwindcss/vite), with vite 7 and
eslint 9 for tooling.

================================================================
6. CONFIGURATION
================================================================

GROQ_API_KEY
  Where: backend/.env
  Default: none
  Notes: Required for /chat, /casefile, /analyze-event. Loaded
  via python-dotenv.

DB_PATH
  Where: backend/database.py
  Default: forensic.db (relative, created in the working
  directory)
  Notes: SQLite file holding all events, case files, chat
  history, and audit logs.

CORS allowed origin
  Where: backend/main.py
  Default: http://localhost:5173
  Notes: Update allow_origins in main.py if you serve the
  frontend from a different host/port.

API base URL
  Where: frontend/src/App.jsx
  Default: http://localhost:8000
  Notes: The API constant -- change if the backend runs
  elsewhere.

DRY_RUN
  Where: backend/response_executor.py
  Default: auto-forced True if not running as Administrator
  Notes: Set explicitly to keep active response in simulate-only
  mode even when elevated.

Scan cooldown
  Where: backend/main.py
  Default: 30 seconds
  Notes: Minimum interval between manual /scan calls.

Integrity cache TTL
  Where: backend/main.py
  Default: 30 seconds
  Notes: How long /integrity results are cached before
  re-walking the hash chain.

Model retrain trigger
  Where: backend/anomaly_detector.py
  Default: >500 new events OR 24h since last train
  Notes: Otherwise the persisted joblib models are reused for
  instant scoring.

================================================================
7. RUNNING THE APP
================================================================

Step 1 -- Start the backend (run your terminal AS ADMINISTRATOR
on Windows for full functionality):

  cd DetectiveLuffy-main/backend
  venv\Scripts\activate
  python main.py

The API starts on http://localhost:8000. On startup it will:
  - Initialize/migrate the SQLite database
  - Load persisted ML models (or note that none exist yet)
  - Backfill integrity hashes for any legacy events
  - Check for Administrator privileges (warns and forces dry-run
    if not elevated)
  - Start the real-time Windows Event Log watcher
  - Launch the background watchdog thread

Step 2 -- Start the frontend (separate terminal):

  cd DetectiveLuffy-main/frontend
  npm run dev

Open http://localhost:5173 in your browser.

Step 3 (optional) -- Seed data without live Windows events: click
into the app and trigger Demo Mode (POST /demo/inject), or run a
manual scan (POST /scan) if you already have Windows Security
event log entries to collect.

================================================================
8. BACKEND MODULES
================================================================

main.py
  FastAPI app entry point. Wires every module together, defines
  all REST endpoints, runs the real-time watchdog thread, and
  drives startup/shutdown sequencing.

database.py
  SQLite connection factory (WAL mode) and idempotent
  schema/migration logic -- events, case_files, chat_history,
  flagged_entities, response_audit tables.

log_collector.py
  Collects events from the Windows Event Log. Provides a
  real-time EvtSubscribe-based watcher (sub-second latency) and a
  batch collect_logs() polling path used at startup and as a
  health-check fallback. Computes chained hashes on insert.

anomaly_detector.py
  Feature extraction + ML scoring. Trains/loads an Isolation
  Forest (anomaly score) and KMeans (behavioral cluster) model,
  persists them with joblib, and exposes score_single_event() for
  instant real-time scoring plus run_anomaly_detection() for
  batch scans. Tracks per-feature contribution ("feature
  importance") for explainability.

integrity.py
  Computes and verifies the SHA-256 hash chain that gives the
  event log tamper-evidence / chain-of-custody guarantees.

detective.py
  Talks to the Groq API to power "Luffy" -- generates narrative
  case files, answers chat questions (with history), and analyzes
  single events, always through sanitized data with an
  injection-guarded prompt.

sanitizer.py
  Redacts/pseudonymizes PII (IPs, usernames, hostnames,
  credentials) before any data reaches the third-party Groq API,
  and hardens data blocks against prompt injection.

response_executor.py
  Executes real Windows active response: disabling an account
  (net user /active:no), blocking an IP (netsh advfirewall), and
  reversing both. Includes a whitelist, elevation check, dry-run
  mode, input validation, and a permanent audit log.

report_generator.py
  Builds "Technical" and "Management" PDF forensic reports with
  ReportLab, pulling from the same event/case-file data as the
  UI.

demo_mode.py
  Injects a deduplicated, multi-phase synthetic attack (brute
  force -> account lockout -> credential access -> service
  persistence -> log clearing) for demos and testing, and a
  matching cleanup function.

================================================================
9. API REFERENCE
================================================================

Base URL: http://localhost:8000

--- Core / Status ---
GET  /                       Service status, watcher/admin state,
                              scan count.
GET  /events                 Top 100 events by anomaly score.
GET  /stats                  Aggregate stats: totals, average
                              threat score, tier breakdown,
                              behavior labels.
POST /scan                   Trigger a manual log collection +
                              anomaly detection pass (30s
                              cooldown).
GET  /watchdog                Poll for new critical alerts,
                              watcher/admin status, scan count.

--- Case Files & Chat (AI Detective) ---
GET  /casefile                Generate a fresh AI narrative case
                              file + confidence score.
GET  /casefile/latest         Fetch the most recently generated
                              case file.
POST /chat                    Send a chat message (or full
                              message history) to Luffy; supports
                              system_override for app-control
                              responses.
GET  /chat/history             Retrieve stored chat history.
POST /analyze-event             Get Luffy's narrative analysis of
                              one event (event_id), plus a
                              suggested UI "mood".

--- Integrity ---
GET  /integrity                  Full SHA-256 chain verification
                              report (cached 30s).
GET  /integrity/event/{event_id}  Integrity status for a single
                              event.

--- Active Response ---
POST /block-entity                 Block a user account or IP
                              (entity, entity_type, reason,
                              threat_tier, dry_run, ...).
POST /unblock-entity                Reverse a previous block.
GET  /blocked-entities                List all currently
                              flagged/blocked entities.
GET  /response-audit                   Immutable audit log of
                              block/unblock actions (limit query
                              param).

--- Analysis Views ---
GET  /feature-importance                Per-event and aggregate
                              ML feature importance for the top
                              30 scored events.
GET  /response-simulation                Simulated tiered
                              response policy per event (Layer 6A
                              autonomy tiers).
GET  /entities                            Correlated entity view
                              -- events grouped by source
                              account/host (limit query param).
GET  /replay-detail/{event_id}             Enriched forensic
                              detail for one event: Windows
                              response context, missed control,
                              forensic significance.

--- Reports ---
GET  /report/pdf              Download the detailed Technical PDF
                              report.
GET  /report/management        Download the executive-summary
                              Management PDF report.

--- Demo ---
POST /demo/inject              Inject the synthetic multi-phase
                              demo attack.
POST /demo/clear                Remove all injected demo events.

================================================================
10. FRONTEND TABS
================================================================

The React app (App.jsx) is organized into seven tabs plus an
always-present Luffy overlay:

EVENTS (dashboard) -- inline in App.jsx
  Primary event table/dashboard, filterable by threat tier.

GRAPHS -- GraphDashboard
  Charted breakdowns of events by tier/time (via recharts).

ENTITIES -- EntityGraph.jsx
  Force-directed graph (via d3) correlating events by
  entity/account/host.

ML SCORES -- Featureimportance.jsx
  Visualizes which features drove each event's anomaly score.

RESPONSE -- Responsesimulation.jsx
  Shows the tiered response policy simulation for current events.

REPLAY -- ReplayTimeline.jsx
  Step-through chronological replay of an incident with forensic
  annotations.

ASK LUFFY -- LuffyTab (in App.jsx)
  Chat interface with the AI detective; supports natural-language
  app control (e.g., "run a scan", "go to the replay tab", "block
  this IP").

The LuffyOverlay.jsx component renders an animated character
(sprites in frontend/public/aria/) whose mood -- idle, thinking,
alert, angry, happy, goofy -- reflects the current investigation
state and drives visual feedback as new alerts arrive.

================================================================
11. MACHINE LEARNING PIPELINE
================================================================

1. Feature extraction -- each Windows event is converted into a
   numeric feature vector (see FEATURE_NAMES / FEATURE_LABELS /
   FEATURE_DESCRIPTIONS in anomaly_detector.py).

2. Isolation Forest (sklearn.ensemble.IsolationForest) --
   unsupervised anomaly scoring; produces the primary
   anomaly_score used to rank and tier events.

3. KMeans (sklearn.cluster.KMeans) -- clusters events into
   behavioral groups, surfaced as cluster_id/cluster_label for
   pattern recognition across the entity graph and replay
   timeline.

4. StandardScaler -- normalizes features before both models are
   applied.

5. Weighted baseline updates -- when retraining, recent data is
   weighted 30% and historical data 70%, so an attacker who
   slowly shifts behavior over time cannot quickly poison the
   baseline.

6. Model persistence -- trained IsolationForest, KMeans, and
   StandardScaler objects are serialized with joblib into
   backend/models/ (isolation_forest.joblib, kmeans.joblib,
   scaler.joblib, tracked via model_meta.json) and reloaded on
   startup, avoiding a cold-start retrain. Retraining is only
   triggered after >500 new events accumulate or 24 hours elapse.

7. Real-time scoring -- score_single_event() scores a single new
   event against the already-loaded models for sub-second alert
   latency, without touching the training/retraining path.

8. Explainability -- per-feature contribution percentages are
   computed and stored per event, exposed via /feature-importance
   for both individual-event and aggregate views.

9. Threat tiers -- the anomaly score maps to a 1-4 threat tier
   that drives alerting, UI color coding, and the
   /response-simulation policy:
     Tier 1 -- Log only (<60% confidence)
     Tier 2 -- Alert analyst (60-85% confidence)
     Tier 3 -- Conditional automated response (>85% confidence)
     Tier 4 -- Full isolation (manual/human authorization only)

================================================================
12. FORENSIC INTEGRITY CHAIN
================================================================

Every event stored in the database is chained like a lightweight
blockchain:

  event_hash = SHA256(raw_data + timestamp + source + prev_hash)

Because each hash incorporates the previous event's hash:
  - Modifying any event invalidates every hash computed after it.
  - Deleting an event breaks the chain (a missing link is
    detectable).
  - Reordering events breaks the chain (the prev_hash no longer
    matches).

GET /integrity walks the full chain and returns a pass/fail
report (cached for 30 seconds to avoid re-walking on every
dashboard poll); GET /integrity/event/{id} checks a single
record. Legacy events collected before the chain existed are
automatically backfilled with hashes on startup
(backfill_hashes()), and every replay-detail view shows a short
hash fingerprint for the event.

================================================================
13. ACTIVE RESPONSE AND SAFETY
================================================================

response_executor.py can take REAL actions on the host machine:

  - Disable a Windows account: net user {account} /active:no
  - Block a source IP: netsh advfirewall firewall add rule ...
  - Reverse either action: re-enable the account / remove the
    firewall rule

Safety controls in place:

1. Whitelist -- SYSTEM, Administrator, and local/loopback IPs can
   never be blocked.

2. Privilege detection -- on startup the app checks whether it's
   running elevated (is_admin()). If not, response actions are
   automatically forced into dry-run mode.

3. Dry-run mode -- commands are built and logged, but not
   executed, unless explicitly running as Administrator and
   dry-run is disabled per-request.

4. Input validation -- account names and IPs are validated with a
   regex allowlist before ever reaching subprocess, preventing
   shell injection.

5. Permanent audit trail -- every attempted block/unblock
   (success or failure) is written to the response_audit table
   and is never deleted; retrievable via GET /response-audit.

IMPORTANT: Only run active-response actions against systems you
are authorized to defend. Treat this feature the same as any
other endpoint-security tooling capable of locking out accounts
or altering firewall state.

================================================================
14. AI DETECTIVE (LUFFY) AND DATA PRIVACY
================================================================

The "Luffy" persona is powered by Groq's hosted LLM API (groq
Python SDK, model configured in detective.py) and is used for:
  - Narrative case file generation (/casefile)
  - Free-form chat with app-control commands (/chat)
  - Per-event analysis in plain language (/analyze-event)

Before any event data is sent to Groq, sanitizer.py performs two
jobs:

1. PII sanitization -- IP addresses are redacted, usernames are
   pseudonymized, and other sensitive fields are stripped from
   event data (sanitize_event_for_ai).

2. Prompt-injection hardening -- event data is wrapped in hard
   delimiters and known injection phrases are neutralized
   (wrap_events_for_prompt, get_injection_guard), so a malicious
   value inside a log field (e.g., a username like "ignore
   previous instructions...") cannot hijack Luffy's behavior.

For higher-tier (3/4) events, Luffy is given a structured evidence
bundle and instructed to cite sources as [DB-ID:X][EventID:XXXX]
so its claims are traceable back to specific database records.

================================================================
15. DEMO MODE
================================================================

For development, testing, or presentations without a live
incident, demo_mode.py injects a realistic five-phase synthetic
attack against a fictitious host/account (DESKTOP-FORENSIC /
rohan.admin / 192.168.1.47):

  1. Brute force -- repeated failed logons (Event ID 4625)
  2. Account lockout -- Windows locks the account (4740)
  3. Credential access -- explicit credential use / credential
     vault access (4648 / 5379)
  4. Persistence -- new service or scheduled task creation
     (7045 / 4698)
  5. Anti-forensics -- Security event log cleared (1102)

POST /demo/inject checks for existing demo event hashes first, so
calling it repeatedly never duplicates data; POST /demo/clear
removes all injected demo events cleanly (detected via a
JSON-parsed "demo": true flag, not a fragile string match).

================================================================
16. PDF REPORTS
================================================================

report_generator.py uses ReportLab to build two report types from
the same live database:

  - Technical Report (GET /report/pdf) -- full multi-page
    forensic detail intended for analysts, including tables,
    per-tier color coding, and page numbers.

  - Management Report (GET /report/management) -- condensed
    executive summary intended for non-technical stakeholders.

Both are streamed back as downloadable PDFs (Content-Disposition:
attachment) named with a timestamp, e.g.
forensic_technical_20260825_143000.pdf.

================================================================
17. DATABASE SCHEMA
================================================================

SQLite database at backend/forensic.db (WAL mode), initialized/
migrated automatically on startup by database.py. Key tables:

events
  Every collected Windows event: raw data, timestamp, source,
  anomaly_score, threat_tier, cluster_id/cluster_label,
  event_hash/prev_hash for the integrity chain.

case_files
  Generated AI narrative case files with timestamps.

chat_history
  Stored Luffy chat conversation history.

flagged_entities
  Accounts/IPs that have been blocked, with reason, threat tier,
  and reversal status.

response_audit
  Immutable log of every active-response action attempted
  (block/unblock, success/failure), for forensic accountability.

Schema upgrades are applied via a safe migration list so existing
databases gain new columns without data loss on next startup.

================================================================
18. TROUBLESHOOTING
================================================================

Symptom: watcher_active: false in /watchdog or /
Cause/fix: pywin32 isn't installed, you're not on Windows, or the
app isn't running as Administrator. Real-time collection needs
elevated Windows Event Log access.

Symptom: Chat/case-file endpoints return errors
Cause/fix: GROQ_API_KEY is missing or invalid in backend/.env.

Symptom: Block/unblock actions report dry_run: true unexpectedly
Cause/fix: The backend detected it isn't running as Administrator
and forced dry-run mode -- restart the terminal/process elevated.

Symptom: Frontend shows no data
Cause/fix: Confirm the backend is running on port 8000, CORS
origin matches your frontend URL, and try POST /scan or POST
/demo/inject to populate events.

Symptom: /integrity reports a broken chain
Cause/fix: Indicates the database was modified outside the app
(or a legitimate legacy backfill gap) -- investigate before
trusting the affected records.

Symptom: Repeated demo events after multiple /demo/inject calls
Cause/fix: Shouldn't happen -- demo_mode.py dedupes by hash; if
you see duplicates, check that forensic.db wasn't manually
edited.

Symptom: Everything works but no ML scores appear
Cause/fix: The Isolation Forest/KMeans models need a minimum
amount of data before they can score meaningfully; run a scan or
inject demo data first.

================================================================
19. ROADMAP IDEAS
================================================================

Not implemented today, but natural extensions given the current
architecture:

  - requirements.txt / pyproject.toml for reproducible backend
    installs
  - Multi-user auth and role-based access to active-response
    actions
  - Pluggable LLM backend (currently hardwired to Groq)
  - Linux/macOS-native log source support (currently Windows
    Event Log only)
  - Export of the integrity chain for independent third-party
    verification

================================================================
20. LICENSE
================================================================

No license file is currently included in this repository. Treat
the code as All Rights Reserved unless the project owner
specifies otherwise, and add a LICENSE file to clarify terms
before distributing or reusing it.
