import json
import logging
import re
import time

import redis.asyncio as redis
from sqlalchemy import text

from app.core.config import settings
from app.core.database import async_session_factory

logger = logging.getLogger("platform.stream")

# ponytail: process-lifetime cache, hostnames are effectively immutable per server.
# Restart (or add a TTL) if renames must show up live.
_hostnames: dict = {}


async def _hostname(slug: str, server_id: str):
    key = (slug, server_id)
    if key in _hostnames:
        return _hostnames[key]
    if not re.match(r"^[a-zA-Z0-9_-]+$", slug):
        return None
    async with async_session_factory() as session:
        row = (await session.execute(
            text(f'SELECT hostname FROM "client_{slug}".servers WHERE id = CAST(:id AS uuid)'),
            {"id": server_id},
        )).fetchone()
    if row:  # misses are not cached (server may be registered a moment later)
        _hostnames[key] = row.hostname
        return row.hostname
    return None


# (slug, agent_id) -> (server_id, expires_at). Short TTL so a merge shows up within a minute.
_agent_servers: dict = {}
_AGENT_TTL = 60.0


async def _server_of_agent(slug: str, agent_id: str) -> str:
    """Heartbeats are keyed by the sentinel (agent) id, which differs from the server id once a
    re-added server has been merged into its earlier record. Falls back to the id unchanged."""
    if not re.match(r"^[a-zA-Z0-9_-]+$", slug):
        return agent_id
    key, now = (slug, agent_id), time.monotonic()
    hit = _agent_servers.get(key)
    if hit and hit[1] > now:
        return hit[0]
    async with async_session_factory() as session:
        row = (await session.execute(
            text(f'SELECT server_id FROM "client_{slug}".sentinel_agents WHERE id = CAST(:id AS uuid)'),
            {"id": agent_id},
        )).fetchone()
    server_id = str(row.server_id) if row else agent_id
    _agent_servers[key] = (server_id, now + _AGENT_TTL)  # errors above raise before caching
    return server_id


async def publish(slug: str, payload: dict) -> None:
    """Push a live event to the tenant's SSE channel. Best-effort: never raises.
    Adds `hostname` next to `server_id` so the UI needs no extra lookup.

    ponytail: new Redis connection per publish; share one client if volume grows.
    """
    if payload.get("type") == "heartbeat" and payload.get("server_id"):
        try:
            payload = {**payload, "server_id": await _server_of_agent(slug, payload["server_id"])}
        except Exception as exc:
            logger.warning("STREAM: agent->server lookup failed for %s: %s", slug, exc)
    if payload.get("server_id") and "hostname" not in payload:
        try:
            payload = {**payload, "hostname": await _hostname(slug, payload["server_id"])}
        except Exception as exc:
            logger.warning("STREAM: hostname lookup failed for %s: %s", slug, exc)
    try:
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        try:
            await r.publish(f"tenant:{slug}:alerts", json.dumps(payload, default=str))
        finally:
            await r.close()
    except Exception as exc:
        logger.warning("STREAM: publish failed for %s: %s", slug, exc)
