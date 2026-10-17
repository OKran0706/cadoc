import json
import logging

import redis.asyncio as redis

from app.core.config import settings

logger = logging.getLogger("platform.stream")


async def publish(slug: str, payload: dict) -> None:
    """Push a live event to the tenant's SSE channel. Best-effort: never raises.

    ponytail: new Redis connection per publish; share one client if volume grows.
    """
    try:
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        try:
            await r.publish(f"tenant:{slug}:alerts", json.dumps(payload, default=str))
        finally:
            await r.close()
    except Exception as exc:
        logger.warning("STREAM: publish failed for %s: %s", slug, exc)
