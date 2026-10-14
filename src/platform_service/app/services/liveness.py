import asyncio
import logging
import redis.asyncio as redis
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.core.config import settings
from app.core.database import async_session_factory

logger = logging.getLogger("platform.liveness")

async def listen_redis_heartbeat_expirations():
    """
    Subscribes to Redis keyspace expirations (__keyevent@0__:expired).
    Extracts agent_id and commits an async database transaction mapping
    that Sentinel status to 'offline' in its target schema.
    """
    logger.info("Initializing Redis keyspace expiration listener...")
    r = redis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    
    # Subscribe to expired events. Ensure Redis config notify-keyspace-events Ex is active.
    await pubsub.subscribe("__keyevent@0__:expired")
    
    try:
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            
            expired_key = message["data"]
            # Expiration keys match: "agent:heartbeat:{company_slug}:{agent_id}"
            if not expired_key.startswith("agent:heartbeat:"):
                continue
            
            logger.warning(f"LIVENESS TIMEOUT DETECTED: Redis heartbeat key expired: {expired_key}")
            parts = expired_key.split(":")
            if len(parts) < 4:
                continue
            
            company_slug = parts[2]
            agent_id = parts[3]
            
            # Reactively write to DB to flag as offline
            await mark_agent_offline(company_slug, agent_id)
            
    except asyncio.CancelledError:
        logger.info("Keyspace subscription listener cancelled")
    except Exception as exc:
        logger.error(f"Keyspace listener error: {exc}")
        # Soft restart listener
        await asyncio.sleep(5)
        asyncio.create_task(listen_redis_heartbeat_expirations())

async def mark_agent_offline(company_slug: str, agent_id: str):
    """Dynamically logs session connections, sets search path, and updates status."""
    async with async_session_factory() as session:
        try:
            # Set search path to target client schema
            await session.execute(
                text("SELECT public.set_tenant_search_path(:slug)"),
                {"slug": company_slug}
            )
            
            # Reactively change active state to 'offline'
            up_res = await session.execute(
                text("""
                    UPDATE sentinel_agents 
                    SET status = 'offline', updated_at = now() 
                    WHERE id = :agent_id AND status != 'offline'
                """),
                {"agent_id": agent_id}
            )
            
            # Log control-plane state change
            if up_res.rowcount > 0:
                # Add to public global audit log
                tenant_res = await session.execute(
                    text("SELECT id FROM public.tenants WHERE slug = :slug"),
                    {"slug": company_slug}
                )
                tenant_row = tenant_res.fetchone()
                if tenant_row:
                    await session.execute(
                        text("""
                            INSERT INTO public.global_audit_log (tenant_id, event_type, payload)
                            VALUES (:tenant_id, 'SENTINEL_LIVENESS_EXPIRED', :payload)
                        """),
                        {
                            "tenant_id": tenant_row.id,
                            "payload": '{"agent_id": "%s"}' % agent_id
                        }
                    )
                
                await session.commit()
                logger.warning(f"SENTINEL_OFFLINE: Agent {agent_id} for client {company_slug} marked offline.")
            
        except Exception as exc:
            await session.rollback()
            logger.error(f"Failed to record offline transition for agent {agent_id} in {company_slug}: {exc}")
