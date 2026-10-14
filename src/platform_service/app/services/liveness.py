import asyncio
import logging
import re
import redis.asyncio as redis
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.core.config import settings
from app.core.database import async_session_factory

logger = logging.getLogger("platform.liveness")

async def listen_redis_heartbeat_expirations():
    """
    Subscribes to Redis keyspace events (__keyevent@0__:expired and __keyevent@0__:set).
    Extracts agent_id and commits an async database transaction mapping
    that Sentinel status to 'active' or 'offline' in its target schema.
    """
    print("Initializing Redis keyspace liveness listener...")
    print("REDIS CONNECTION URL BEING USED:", settings.REDIS_URL)
    try:
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        pubsub = r.pubsub()
        await pubsub.subscribe("__keyevent@0__:expired", "__keyevent@0__:set")
        print("Liveness listener successfully subscribed!")
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            
            channel = message["channel"]
            event_key = message["data"]
            # Keys match: "agent:heartbeat:{company_slug}:{agent_id}"
            if not event_key.startswith("agent:heartbeat:"):
                continue
            
            parts = event_key.split(":")
            if len(parts) < 4:
                continue
            
            company_slug = parts[2]
            agent_id = parts[3]
            
            import uuid
            try:
                uuid.UUID(agent_id)
            except ValueError:
                agent_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, agent_id))
            
            if channel.endswith(":expired"):
                print(f"LIVENESS TIMEOUT DETECTED: Redis heartbeat key expired: {event_key}")
                await mark_agent_offline(company_slug, agent_id)
            elif channel.endswith(":set"):
                print(f"LIVENESS ACTIVE DETECTED: Redis heartbeat key set: {event_key}")
                await mark_agent_online(company_slug, agent_id)
            
    except asyncio.CancelledError:
        logger.info("Keyspace subscription listener cancelled")
    except Exception as exc:
        logger.error(f"Keyspace listener error: {exc}")
        # Soft restart listener
        await asyncio.sleep(5)
        asyncio.create_task(listen_redis_heartbeat_expirations())

async def mark_agent_online(company_slug: str, agent_id: str):
    """Dynamically logs session connections and updates status to active."""
    # Safety check to prevent SQL injection
    if not re.match(r"^[a-zA-Z0-9_-]+$", company_slug):
        print(f"Skipping online transition for unsafe client slug: {company_slug}")
        return

    async with async_session_factory() as session:
        try:
            await session.begin()
            # Set search path to keep tests / connection session happy
            await session.execute(text(f"SET search_path = client_{company_slug}"))
            # Reactively change active state to 'active'
            up_res = await session.execute(
                text(f"""
                    UPDATE client_{company_slug}.sentinel_agents 
                    SET status = 'active', last_connected_at = now(), updated_at = now() 
                    WHERE id = :agent_id AND status != 'active'
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
                            VALUES (:tenant_id, 'SENTINEL_LIVENESS_ACTIVE', :payload)
                        """),
                        {
                            "tenant_id": tenant_row.id,
                            "payload": '{"agent_id": "%s"}' % agent_id
                        }
                    )
                
            await session.commit()
            if up_res.rowcount > 0:
                print(f"SENTINEL_ACTIVE: Agent {agent_id} for client {company_slug} marked online/active.")
            
        except Exception as exc:
            await session.rollback()
            print(f"Failed to record active transition for agent {agent_id} in {company_slug}: {exc}")

async def mark_agent_offline(company_slug: str, agent_id: str):
    """Dynamically logs session connections and updates status."""
    # Safety check to prevent SQL injection
    if not re.match(r"^[a-zA-Z0-9_-]+$", company_slug):
        print(f"Skipping offline transition for unsafe client slug: {company_slug}")
        return

    async with async_session_factory() as session:
        try:
            await session.begin()
            # Set search path to keep tests / connection session happy
            await session.execute(text(f"SET search_path = client_{company_slug}"))
            # Reactively change active state to 'offline'
            up_res = await session.execute(
                text(f"""
                    UPDATE client_{company_slug}.sentinel_agents 
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
            if up_res.rowcount > 0:
                print(f"SENTINEL_OFFLINE: Agent {agent_id} for client {company_slug} marked offline.")
            
        except Exception as exc:
            await session.rollback()
            print(f"Failed to record offline transition for agent {agent_id} in {company_slug}: {exc}")
