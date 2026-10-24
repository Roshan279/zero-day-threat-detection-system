"""
scope.py
A "scope" narrows the events to one circumstance: a threat level, a behaviour pattern, one entity (log source),
a time range, or any mix. The events list and both PDF reports use the same filter, so the book and the PDF
always describe the same events.
"""
import json
from typing import Optional

TIER_NAMES = {1: "LOW", 2: "MEDIUM", 3: "HIGH", 4: "CRITICAL"}


def make_scope(tier: Optional[int] = None, cluster: Optional[str] = None, entity: Optional[str] = None,
               start: Optional[str] = None, end: Optional[str] = None) -> dict:
    """Only the parts that were actually given."""
    scope = {}
    if tier in (1, 2, 3, 4):
        scope["tier"] = tier
    if cluster:
        scope["cluster"] = cluster
    if entity:
        scope["entity"] = entity
    if start:
        scope["start"] = start
    if end:
        scope["end"] = end
    return scope


def scope_where(scope: Optional[dict]) -> tuple:
    """A WHERE clause (with its leading ' WHERE ', or empty) and its parameters."""
    if not scope:
        return "", []
    parts, params = [], []
    if "tier" in scope:
        parts.append("threat_tier = ?")
        params.append(int(scope["tier"]))
    if "cluster" in scope:
        parts.append("cluster_label = ?")
        params.append(scope["cluster"])
    if "entity" in scope:
        # entities are the SourceName inside the stored JSON
        parts.append("raw_data LIKE ?")
        params.append('%"SourceName": ' + json.dumps(scope["entity"]) + "%")
    # timestamps are stored both as "2026-10-21 10:30:01" and "2026-10-23T16:35:22": compare them in one form
    if "start" in scope:
        parts.append("replace(timestamp, 'T', ' ') >= ?")
        params.append(scope["start"].replace("T", " "))
    if "end" in scope:
        parts.append("replace(timestamp, 'T', ' ') <= ?")
        end = scope["end"].replace("T", " ")
        params.append(end + " 23:59:59" if len(end) == 10 else end)
    if not parts:
        return "", []
    return " WHERE " + " AND ".join(parts), params


def scope_label(scope: Optional[dict]) -> str:
    """One line that says what the report covers."""
    if not scope:
        return "Whole case: every event on file"
    bits = []
    if "tier" in scope:
        bits.append(f"threat level {TIER_NAMES.get(int(scope['tier']), scope['tier'])}")
    if "cluster" in scope:
        bits.append(f"behaviour: {scope['cluster']}")
    if "entity" in scope:
        bits.append(f"entity: {scope['entity']}")
    if "start" in scope or "end" in scope:
        bits.append(f"from {scope.get('start', 'the start')} to {scope.get('end', 'now')}")
    return "Scoped to " + "; ".join(bits)
