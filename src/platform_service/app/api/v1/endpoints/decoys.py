from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
from typing import Optional, List
import re
from app.core.database import get_db_session, set_tenant_search_path
from app.core.security import RequirePermission

router = APIRouter()

class DecoyResponse(BaseModel):
    id: str
    server_id: str
    file_path: str
    decoy_type: str
    original_hash: str
    status: str
    planted_at: str
    last_verified: Optional[str] = None
    created_at: str
    updated_at: str

@router.get("/", response_model=List[DecoyResponse])
async def list_decoys(
    status: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("security.read"))
):
    """
    Exposes read-only, schema-isolated listings of active canary decoy files.
    """
    company_slug = admin["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
    
    # 1. Prevent SQL injection on company_slug
    if not re.match(r"^[a-zA-Z0-9_-]+$", company_slug):
        raise HTTPException(status_code=400, detail="Invalid tenant identifier")

    # 2. Switch connection search path
    await set_tenant_search_path(db, company_slug)
    
    # 3. Dynamic filter building
    params = {}
    where_clause = ""
    if status:
        allowed_statuses = {'planted', 'tampered', 'cleaned_up', 'verification_failed'}
        if status not in allowed_statuses:
            raise HTTPException(status_code=400, detail=f"Invalid status filter. Must be one of {allowed_statuses}")
        where_clause = "WHERE status = :status"
        params["status"] = status
        
    sql = f"""
        SELECT id, server_id, file_path, decoy_type, original_hash, status,
               planted_at::text, last_verified::text, created_at::text, updated_at::text
        FROM client_{company_slug}.canary_decoy_files
        {where_clause}
        ORDER BY planted_at DESC, id DESC
    """
    
    try:
        result = await db.execute(text(sql), params)
        rows = result.fetchall()
        
        return [
            DecoyResponse(
                id=str(r.id),
                server_id=str(r.server_id),
                file_path=r.file_path,
                decoy_type=r.decoy_type,
                original_hash=r.original_hash,
                status=r.status,
                planted_at=r.planted_at,
                last_verified=r.last_verified,
                created_at=r.created_at,
                updated_at=r.updated_at
            ) for r in rows
        ]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query decoy registry: {exc}")

@router.get("/{decoy_id}", response_model=DecoyResponse)
async def get_decoy(
    decoy_id: str,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("security.read"))
):
    """
    Exposes read-only detailed query of a specific decoy registry entry.
    """
    company_slug = admin["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    if not re.match(r"^[a-zA-Z0-9_-]+$", company_slug):
        raise HTTPException(status_code=400, detail="Invalid tenant identifier")
        
    await set_tenant_search_path(db, company_slug)
    
    sql = f"""
        SELECT id, server_id, file_path, decoy_type, original_hash, status,
               planted_at::text, last_verified::text, created_at::text, updated_at::text
        FROM client_{company_slug}.canary_decoy_files
        WHERE id = :decoy_id
    """
    
    try:
        result = await db.execute(text(sql), {"decoy_id": decoy_id})
        r = result.fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Decoy file not found")
            
        return DecoyResponse(
            id=str(r.id),
            server_id=str(r.server_id),
            file_path=r.file_path,
            decoy_type=r.decoy_type,
            original_hash=r.original_hash,
            status=r.status,
            planted_at=r.planted_at,
            last_verified=r.last_verified,
            created_at=r.created_at,
            updated_at=r.updated_at
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch decoy: {exc}")
