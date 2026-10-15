from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import redis.asyncio as redis
import json
import re
from app.core.config import settings
from app.core.database import get_db_session, set_tenant_search_path
from app.core.security import RequirePermission

router = APIRouter()

@router.post("/{agent_id}/decommission")
async def decommission_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("security.respond"))
):
    """
    Decommissions a Sentinel agent:
    1. Updates Postgres status to 'offline' within the client schema.
    2. Writes agent ID blacklist entry in Redis.
    3. Adds audit entry into global log.
    """
    company_slug = admin["company_slug"]
    tenant_id = admin["tenant_id"]
    
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    if not re.match(r"^[a-zA-Z0-9_-]+$", company_slug):
        raise HTTPException(status_code=400, detail="Invalid tenant identifier")

    await set_tenant_search_path(db, company_slug)
    
    try:
        # Check if agent exists
        chk_res = await db.execute(
            text(f"SELECT id FROM client_{company_slug}.sentinel_agents WHERE id = :agent_id"),
            {"agent_id": agent_id}
        )
        if not chk_res.fetchone():
            raise HTTPException(status_code=404, detail="Sentinel agent not found")
            
        # 1. Update DB Status
        await db.execute(
            text(f"""
                UPDATE client_{company_slug}.sentinel_agents 
                SET status = 'offline', updated_at = now() 
                WHERE id = :agent_id
            """),
            {"agent_id": agent_id}
        )
        
        # 2. Log to Global Audit
        payload_data = {"agent_id": agent_id, "action": "decommissioned"}
        await db.execute(
            text("""
                INSERT INTO public.global_audit_log (tenant_id, event_type, payload)
                VALUES (:tenant_id, 'SENTINEL_DECOMMISSIONED', :payload)
            """),
            {
                "tenant_id": tenant_id,
                "payload": json.dumps(payload_data)
            }
        )
        
        # 3. Add to Redis Blacklist
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        await r.set(f"agent:revoked:{agent_id}", "true")
        
        await db.commit()
        return {"status": "success", "message": f"Agent {agent_id} successfully decommissioned"}
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to decommission agent: {exc}")

@router.post("/{agent_id}/recommission")
async def recommission_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("security.respond"))
):
    """
    Recommissions a decommissioned Sentinel agent:
    1. Updates Postgres status back to 'active' within the client schema.
    2. Deletes agent ID blacklist entry from Redis.
    3. Adds audit entry into global log.
    """
    company_slug = admin["company_slug"]
    tenant_id = admin["tenant_id"]
    
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    if not re.match(r"^[a-zA-Z0-9_-]+$", company_slug):
        raise HTTPException(status_code=400, detail="Invalid tenant identifier")

    await set_tenant_search_path(db, company_slug)
    
    try:
        # Check if agent exists
        chk_res = await db.execute(
            text(f"SELECT id FROM client_{company_slug}.sentinel_agents WHERE id = :agent_id"),
            {"agent_id": agent_id}
        )
        if not chk_res.fetchone():
            raise HTTPException(status_code=404, detail="Sentinel agent not found")
            
        # 1. Update DB Status
        await db.execute(
            text(f"""
                UPDATE client_{company_slug}.sentinel_agents 
                SET status = 'active', updated_at = now() 
                WHERE id = :agent_id
            """),
            {"agent_id": agent_id}
        )
        
        # 2. Log to Global Audit
        payload_data = {"agent_id": agent_id, "action": "recommissioned"}
        await db.execute(
            text("""
                INSERT INTO public.global_audit_log (tenant_id, event_type, payload)
                VALUES (:tenant_id, 'SENTINEL_RECOMMISSIONED', :payload)
            """),
            {
                "tenant_id": tenant_id,
                "payload": json.dumps(payload_data)
            }
        )
        
        # 3. Remove from Redis Blacklist
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        await r.delete(f"agent:revoked:{agent_id}")
        
        await db.commit()
        return {"status": "success", "message": f"Agent {agent_id} successfully recommissioned"}
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to recommission agent: {exc}")
