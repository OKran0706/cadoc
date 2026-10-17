"""
Kafka -> Postgres writer for sentinel events.

Consumes `canary-events` (messages tagged with an `identity` header = mTLS-verified
`{company_slug}.{sentinel_id}` by the ingestion service) and records:
  - CANARY_MAP_DEPLOYED          -> canary_decoy_files (what the map/decoy list shows)
  - SENTINEL_FILE_*              -> tamper_alerts (DECOY_TAMPER) + decoy status 'tampered'
  - BINARY_TAMPERED, ALERT_*     -> tamper_alerts (BINARY_TAMPER / SYSTEM_INTEGRITY_FAIL)
  - CANARY_CLEANUP               -> decoy status 'cleaned_up' (sentinel removed leftover canaries)
  - SENTINEL_FINGERPRINT         -> servers.fingerprint; merges a re-added server into its earlier record (alias) + records a SERVER_READDED notice
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
_UUID = re.compile(r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
_MAX_CLEANUP_IDS = 1000

# Informational notices (low severity) recorded when a machine is registered again. They never
# block enrollment or deployment.
_READDED_MERGED = ("This machine was registered before (previous server re-added). The previous server "
                   "record was kept and updated with the new details; leftover canaries are being cleaned up.")
_READDED_ACTIVE = ("This machine was registered before (previous server re-added), but the previous "
                   "server's agent is still active, so both records were kept.")
_READDED_HAS_ALERTS = ("This machine was registered before (previous server re-added), but the new server "
                       "already has alerts, so the records were not merged.")

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
    details = {k: payload.get(k) for k in ("op", "path", "dest_path", "pid", "tid", "uid", "auid", "ses", "tty", "src_ip", "user", "login_user", "ppid", "parent_comm", "success", "exit", "cmdline", "comm", "exe", "cwd", "audit_id", "confidence", "host") if payload.get(k) is not None}
    details["decoy_id"] = str(decoy.id)
    live = await _insert_alert(session, slug, server_id, "DECOY_TAMPER", file_severity(op), details, parse_ts(payload.get("ts")))
    await session.execute(
        text(f"""UPDATE "{schema}".canary_decoy_files SET status = 'tampered', updated_at = now()
                 WHERE id = :id"""),
        {"id": decoy.id},
    )
    logger.info("EVENT_WRITER: DECOY_TAMPER slug=%s server=%s op=%s path=%s", slug, server_id, op, path)
    return live


async def _resolve_server(session, schema: str, server_id: str) -> str:
    """A merged (re-added) server's new sentinel identity maps to the surviving record."""
    res = await session.execute(
        text(f"""SELECT server_id FROM "{schema}".server_aliases WHERE alias_id = CAST(:sid AS uuid)"""),
        {"sid": server_id},
    )
    row = res.fetchone()
    return str(row.server_id) if row else server_id


async def _merge_servers(session, schema: str, old: str, new: str, own, fp: str) -> None:
    """Fold the freshly added server row `new` into the earlier record `old`.

    `old` keeps its id, project, roles and alert history (tamper_alerts are immutable, so they
    are never touched); it takes `new`'s hostname/ip/specs/status. `new` is deleted and its
    sentinel identity recorded as an alias of `old`.

    Order matters: retire the old agent and orphan the old decoys before re-pointing the new
    ones (CANARY_MAP_DEPLOYED bulk-resets 'planted' rows and would hide them), re-point before
    deleting `new` so the ON DELETE CASCADE has nothing left to remove, and delete `new` before
    renaming `old` (hostname is UNIQUE).
    """
    ids = {"old": old, "new": new}
    await session.execute(
        text(f"""UPDATE "{schema}".sentinel_agents SET status = 'decommissioned', updated_at = now()
                 WHERE server_id = CAST(:old AS uuid)"""), {"old": old})
    await session.execute(
        text(f"""UPDATE "{schema}".canary_decoy_files SET status = 'orphaned', updated_at = now()
                 WHERE server_id = CAST(:old AS uuid) AND status = 'planted'"""), {"old": old})
    for table in ("sentinel_agents", "canary_decoy_files", "server_aliases"):
        await session.execute(
            text(f"""UPDATE "{schema}".{table} SET server_id = CAST(:old AS uuid)
                     WHERE server_id = CAST(:new AS uuid)"""), ids)
    await session.execute(text(f"""DELETE FROM "{schema}".servers WHERE id = CAST(:new AS uuid)"""), {"new": new})
    await session.execute(
        text(f"""UPDATE "{schema}".servers SET hostname = :hostname, ip_address = CAST(:ip AS inet),
                     status = :status, specs = CAST(:specs AS jsonb), fingerprint = :fp, updated_at = now()
                 WHERE id = CAST(:old AS uuid)"""),
        {"old": old, "hostname": own.hostname, "ip": own.ip_address, "status": own.status,
         "specs": json.dumps(own.specs or {}), "fp": fp},
    )
    await session.execute(
        text(f"""INSERT INTO "{schema}".server_aliases (alias_id, server_id)
                 VALUES (CAST(:alias AS uuid), CAST(:old AS uuid))
                 ON CONFLICT (alias_id) DO UPDATE SET server_id = EXCLUDED.server_id"""),
        {"alias": new, "old": old},
    )
    logger.info("EVENT_WRITER: merged server %s into %s (same fingerprint, old agent dead)", new, old)


async def _handle_fingerprint(session, slug: str, server_id: str, payload: dict) -> Optional[dict]:
    fp = payload.get("fingerprint")
    if not isinstance(fp, str) or not _HEX64.match(fp):
        return None
    fp = fp.lower()
    schema = f"client_{slug}"
    res = await session.execute(
        text(f"""SELECT id, fingerprint, hostname, ip_address::text AS ip_address, specs, status
                 FROM "{schema}".servers WHERE id = CAST(:sid AS uuid)"""),
        {"sid": server_id},
    )
    own = res.fetchone()
    if not own or own.fingerprint == fp:
        return None
    res = await session.execute(
        text(f"""SELECT id FROM "{schema}".servers WHERE fingerprint = :fp AND id <> CAST(:sid AS uuid) LIMIT 1"""),
        {"fp": fp, "sid": server_id},
    )
    match = res.fetchone()
    if not match:
        await session.execute(
            text(f"""UPDATE "{schema}".servers SET fingerprint = :fp, updated_at = now()
                     WHERE id = CAST(:sid AS uuid)"""), {"fp": fp, "sid": server_id})
        return None
    old = str(match.id)
    ts = parse_ts(payload.get("ts"))
    ids = {"existing_server_id": old, "new_server_id": server_id}
    res = await session.execute(
        text(f"""SELECT 1 FROM "{schema}".sentinel_agents
                 WHERE server_id = CAST(:old AS uuid) AND status NOT IN ('offline', 'decommissioned') LIMIT 1"""),
        {"old": old},
    )
    if res.fetchone():  # earlier agent still alive: keep both records, just note it
        return await _insert_alert(session, slug, server_id, "SERVER_READDED", "low",
                                   {**ids, "action": "kept_separate_active", "message": _READDED_ACTIVE}, ts)
    res = await session.execute(
        text(f"""SELECT 1 FROM "{schema}".tamper_alerts WHERE server_id = CAST(:sid AS uuid) LIMIT 1"""),
        {"sid": server_id},
    )
    if res.fetchone():  # alerts are immutable: a server that has any cannot be deleted
        return await _insert_alert(session, slug, server_id, "SERVER_READDED", "low",
                                   {**ids, "action": "kept_separate_has_alerts", "message": _READDED_HAS_ALERTS}, ts)
    await _merge_servers(session, schema, old, server_id, own, fp)
    # the new row is gone, so the notice is recorded on the surviving server
    return await _insert_alert(session, slug, old, "SERVER_READDED", "low",
                               {**ids, "action": "merged", "message": _READDED_MERGED}, ts)


async def _handle_cleanup(session, slug: str, server_id: str, payload: dict) -> None:
    """Sentinel acknowledges removed canaries. Scoped to the sender's own server (from the cert)."""
    raw = payload.get("ids")
    if not isinstance(raw, list):
        return
    ids = list(dict.fromkeys(i.lower() for i in raw if isinstance(i, str) and _UUID.match(i)))[:_MAX_CLEANUP_IDS]
    if not ids:
        return
    schema = f"client_{slug}"
    await session.execute(
        text(f"""UPDATE "{schema}".canary_decoy_files SET status = 'cleaned_up', updated_at = now()
                 WHERE id = ANY(CAST(:ids AS uuid[])) AND server_id = CAST(:sid AS uuid)
                   AND status IN ('planted', 'tampered', 'orphaned')"""),
        {"ids": ids, "sid": server_id},
    )
    logger.info("EVENT_WRITER: cleanup ack slug=%s server=%s ids=%d", slug, server_id, len(ids))


async def handle_event(identity: str, payload: dict) -> None:
    ident = parse_identity(identity or "")
    if not ident:
        logger.info("EVENT_WRITER: dropping event with bad/missing identity %r", identity)
        return
    slug, server_id = ident
    etype = payload.get("type", "")
    if not (etype in ("CANARY_MAP_DEPLOYED", "CANARY_CLEANUP", "SENTINEL_FINGERPRINT")
            or etype.startswith("SENTINEL_FILE_") or etype in _SYSTEM_ALERTS):
        return
    live = None
    async with async_session_factory() as session:
        try:
            await session.begin()
            server_id = await _resolve_server(session, f"client_{slug}", server_id)
            if etype == "CANARY_MAP_DEPLOYED":
                await _handle_map(session, slug, server_id, payload)
            elif etype == "CANARY_CLEANUP":
                await _handle_cleanup(session, slug, server_id, payload)
            elif etype == "SENTINEL_FINGERPRINT":
                live = await _handle_fingerprint(session, slug, server_id, payload)
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
