"""
Kafka -> Postgres writer for sentinel events.

Consumes `canary-events` (messages tagged with an `identity` header = mTLS-verified
`{company_slug}.{sentinel_id}` by the ingestion service) and records:
  - CANARY_MAP_DEPLOYED          -> canary_decoy_files (what the map/decoy list shows)
  - SENTINEL_FILE_*              -> tamper_alerts (DECOY_TAMPER) + decoy status 'tampered'
  - BINARY_TAMPERED, ALERT_*     -> tamper_alerts (BINARY_TAMPER / SYSTEM_INTEGRITY_FAIL)
Everything else is ignored.

ponytail: at-most-once, no dead-letter queue; a failed message is logged and skipped.
Add a DLQ topic if alerts must never be lost.
"""
import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import text

from app.core.config import settings
from app.core.database import async_session_factory
from app.services.stream import publish

logger = logging.getLogger("platform.event_writer")

_ID_PART = re.compile(r"^[A-Za-z0-9_-]+$")
_HEX64 = re.compile(r"^[A-Fa-f0-9]{64}$")

# Same split as ingestion_service.liveness.parse_agent_cn ({slug}.{sentinel_id}).
def parse_identity(identity: str) -> Optional[tuple]:
    parts = identity.split(".", 1)
    if len(parts) != 2 or not all(_ID_PART.match(p) for p in parts):
        return None
    return parts[0], parts[1]


def parse_ts(value: Optional[str]) -> datetime:
    """RFC3339(Nano) -> aware datetime. Go emits 9 fractional digits; Python wants <= 6."""
    if not value:
        return datetime.now(timezone.utc)
    v = re.sub(r"(\.\d{6})\d+", r"\1", value.replace("Z", "+00:00"))
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


_CRITICAL_OPS = {"WRITE", "DELETE", "RENAME", "TRUNCATE", "CHMOD", "CHOWN"}


def file_severity(op: str) -> str:
    return "critical" if op in _CRITICAL_OPS else "high"  # READ / OPEN


# event type -> (tamper_alerts.event_type, severity) for non-file alerts
_SYSTEM_ALERTS = {
    "BINARY_TAMPERED": ("BINARY_TAMPER", "critical"),
    "ALERT_SENTINEL_TAMPER": ("SYSTEM_INTEGRITY_FAIL", "high"),
    "ALERT_SENTINEL_PTRACE_ATTEMPT": ("SYSTEM_INTEGRITY_FAIL", "high"),
}


async def _insert_alert(session, slug: str, server_id: str, event_type: str, severity: str,
                        details: dict, detected_at: datetime) -> dict:
    """Insert an alert; returns the live-stream payload (published by the caller after commit)."""
    schema = f"client_{slug}"
    # Only current+next month partitions exist at provisioning; make sure this one does.
    await session.execute(
        text("SELECT public.ensure_monthly_range_partition(:schema, 'tamper_alerts', :ts)"),
        {"schema": schema, "ts": detected_at},
    )
    res = await session.execute(
        text(f"""
            INSERT INTO "{schema}".tamper_alerts (server_id, agent_id, event_type, severity, details, detected_at)
            VALUES (
                CAST(:sid AS uuid),
                (SELECT id FROM "{schema}".sentinel_agents WHERE id = CAST(:sid AS uuid)),
                :etype, :sev, CAST(:details AS jsonb), :ts
            )
            RETURNING id
        """),
        {"sid": server_id, "etype": event_type, "sev": severity,
         "details": json.dumps(details), "ts": detected_at},
    )
    return {"type": "alert", "id": str(res.scalar()), "server_id": server_id, "event_type": event_type,
            "severity": severity, "details": details, "detected_at": detected_at.isoformat()}


async def _handle_map(session, slug: str, server_id: str, payload: dict) -> None:
    schema = f"client_{slug}"
    # Two decoys can resolve to the same path (the later write replaces the earlier file),
    # so keep one row per path: the last entry is what is actually on disk.
    by_path = {c.get("path"): c for c in ((payload.get("map") or {}).get("canaries") or []) if c.get("path")}
    canaries = list(by_path.values())
    # A new map replaces the previous one (the deployer removed the old files on rotation).
    await session.execute(
        text(f"""UPDATE "{schema}".canary_decoy_files SET status = 'cleaned_up', updated_at = now()
                 WHERE server_id = CAST(:sid AS uuid) AND status = 'planted'"""),
        {"sid": server_id},
    )
    for c in canaries:
        if not _HEX64.match(str(c.get("sha256", ""))):
            logger.warning("EVENT_WRITER: skipping canary with bad sha256 path=%s", c.get("path"))
            continue
        await session.execute(
            text(f"""
                INSERT INTO "{schema}".canary_decoy_files
                    (id, server_id, file_path, decoy_type, original_hash, status, planted_at)
                VALUES (CAST(:id AS uuid), CAST(:sid AS uuid), :path, :dtype, :hash, 'planted', :planted)
                ON CONFLICT (id) DO NOTHING
            """),
            {"id": c["id"], "sid": server_id, "path": c["path"][:512], "dtype": str(c.get("type", "unknown"))[:50],
             "hash": c["sha256"], "planted": parse_ts(c.get("planted_at"))},
        )
    logger.info("EVENT_WRITER: canary map recorded slug=%s server=%s canaries=%d", slug, server_id, len(canaries))


async def _handle_file_event(session, slug: str, server_id: str, payload: dict) -> Optional[dict]:
    schema = f"client_{slug}"
    path = payload.get("path", "")
    res = await session.execute(
        text(f"""SELECT id FROM "{schema}".canary_decoy_files
                 WHERE server_id = CAST(:sid AS uuid) AND file_path = :path AND status IN ('planted', 'tampered')
                 LIMIT 1"""),
        {"sid": server_id, "path": path},
    )
    decoy = res.fetchone()
    if not decoy:
        logger.info("EVENT_WRITER: file event on non-decoy path %s ignored", path)
        return None
    op = payload.get("op", "")
    details = {k: payload.get(k) for k in ("op", "path", "dest_path", "pid", "audit_id", "confidence", "host") if payload.get(k) is not None}
    details["decoy_id"] = str(decoy.id)
    live = await _insert_alert(session, slug, server_id, "DECOY_TAMPER", file_severity(op), details, parse_ts(payload.get("ts")))
    await session.execute(
        text(f"""UPDATE "{schema}".canary_decoy_files SET status = 'tampered', updated_at = now()
                 WHERE id = :id"""),
        {"id": decoy.id},
    )
    logger.info("EVENT_WRITER: DECOY_TAMPER slug=%s server=%s op=%s path=%s", slug, server_id, op, path)
    return live


async def handle_event(identity: str, payload: dict) -> None:
    ident = parse_identity(identity or "")
    if not ident:
        logger.info("EVENT_WRITER: dropping event with bad/missing identity %r", identity)
        return
    slug, server_id = ident
    etype = payload.get("type", "")
    if not (etype == "CANARY_MAP_DEPLOYED" or etype.startswith("SENTINEL_FILE_") or etype in _SYSTEM_ALERTS):
        return
    live = None
    async with async_session_factory() as session:
        try:
            await session.begin()
            if etype == "CANARY_MAP_DEPLOYED":
                await _handle_map(session, slug, server_id, payload)
            elif etype.startswith("SENTINEL_FILE_"):
                live = await _handle_file_event(session, slug, server_id, payload)
            else:
                alert_type, severity = _SYSTEM_ALERTS[etype]
                details = {k: v for k, v in payload.items() if k not in ("prev_hash", "seq")}
                live = await _insert_alert(session, slug, server_id, alert_type, severity, details, parse_ts(payload.get("ts")))
            await session.commit()
        except Exception as exc:
            await session.rollback()
            logger.error("EVENT_WRITER: failed to record %s for %s: %s", etype, identity, exc)
            return
    if live:  # only after a successful commit
        await publish(slug, live)


async def run_event_writer() -> None:
    """Background task: consume canary-events forever. No-op if Kafka isn't configured."""
    if not settings.KAFKA_BOOTSTRAP_SERVERS:
        logger.info("EVENT_WRITER: KAFKA_BOOTSTRAP_SERVERS not set, writer disabled")
        return
    from aiokafka import AIOKafkaConsumer  # lazy: keeps the app importable without Kafka

    consumer = None
    try:
        while consumer is None:
            c = AIOKafkaConsumer(
                settings.KAFKA_TOPIC,
                bootstrap_servers=settings.KAFKA_BOOTSTRAP_SERVERS,
                group_id="platform-writer",
                auto_offset_reset="earliest",
            )
            try:
                await c.start()
                consumer = c
            except Exception as exc:
                logger.warning("EVENT_WRITER: Kafka not ready (%s), retrying in 5s", exc)
                await asyncio.sleep(5)
        logger.info("EVENT_WRITER: consuming %s as group platform-writer", settings.KAFKA_TOPIC)
        async for msg in consumer:
            identity = next((v.decode("utf-8", "replace") for k, v in (msg.headers or []) if k == "identity"), "")
            try:
                payload = json.loads(msg.value)
            except (ValueError, TypeError):
                continue
            await handle_event(identity, payload)
    except asyncio.CancelledError:
        pass
    finally:
        if consumer is not None:
            await consumer.stop()
