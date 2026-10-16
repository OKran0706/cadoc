import redis.asyncio as redis
import logging
import os
import re

logger = logging.getLogger("ingestion.liveness")

class LivenessManager:
    def __init__(self, redis_url: str):
        self.redis = redis.from_url(redis_url)

    async def update_liveness(self, sentinel_id: str, payload: str, company_slug: str, ttl: int = 90):
        """
        Updates the liveness key for a sentinel with a 90s TTL.
        """
        key = f"agent:heartbeat:{company_slug}:{sentinel_id}"
        await self.redis.set(key, payload, ex=ttl)
        logger.debug(f"LIVENESS_UPDATED: {key} (ttl={ttl}s)")

    async def close(self):
        await self.redis.close()


_ID_PART = re.compile(r"^[A-Za-z0-9_-]+$")


def parse_agent_cn(cn: str):
    """
    Split a verified client-cert CN into (company_slug, sentinel_id), or None if malformed.
    Vault issues '{slug}.{sentinel_id}' (the '.canary.local' suffix is already stripped by
    the caller); the legacy 'agent:{slug}:{id}' form is still accepted. Parts are restricted
    to [A-Za-z0-9_-] so they can never inject ':' into the Redis heartbeat key.
    """
    if cn.startswith("agent:"):
        parts = cn.split(":")[1:]
    else:
        parts = cn.split(".", 1)
    if len(parts) != 2 or not all(_ID_PART.match(p) for p in parts):
        return None
    return parts[0], parts[1]
