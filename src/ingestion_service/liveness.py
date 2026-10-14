import redis.asyncio as redis
import logging
import os

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
