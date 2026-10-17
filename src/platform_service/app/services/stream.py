import json
import logging
import re

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


async def publish(slug: str, payload: dict) -> None:
    """Push a live event to the tenant's SSE channel. Best-effort: never raises.
    Adds `hostname` next to `server_id` so the UI needs no extra lookup.

    ponytail: new Redis connection per publish; share one client if volume grows.
    """
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
