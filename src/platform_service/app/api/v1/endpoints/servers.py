from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
from typing import Optional, List
import json
import re
from app.core.database import get_db_session, set_tenant_search_path
from app.core.security import RequirePermission

router = APIRouter()

class ServerCreate(BaseModel):
    project_id: str
    hostname: str
    ip_address: str
    status: Optional[str] = "online"
    specs: Optional[dict] = {}
    company_slug: Optional[str] = None  # to allow global admins to target a tenant

class ServerResponse(BaseModel):
    id: str
    project_id: str
    hostname: str
    ip_address: str
    status: str
    specs: dict
    created_at: str
    updated_at: str

@router.post("/", response_model=ServerResponse)
async def create_server(
    req: ServerCreate,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("server.manage"))
):
    """
    Registers a new server under a project in the tenant's schema.
    """
    caller_slug = admin["company_slug"]
    if caller_slug == "global":
        if not req.company_slug:
            raise HTTPException(status_code=400, detail="Global administrator must target a specific company slug")
        target_slug = req.company_slug
    else:
        target_slug = caller_slug

    if not re.match(r"^[a-zA-Z0-9_-]+$", target_slug):
        raise HTTPException(status_code=400, detail="Invalid tenant identifier")

    await set_tenant_search_path(db, target_slug)

    try:
        # Check if project exists (supports UUID or project name)
        proj_res = await db.execute(
            text(f"SELECT id FROM \"client_{target_slug}\".projects WHERE id::text = :project_id OR name = :project_id LIMIT 1"),
            {"project_id": req.project_id}
        )
        proj_row = proj_res.fetchone()
        if not proj_row:
            raise HTTPException(status_code=404, detail="Project not found")

        result = await db.execute(
            text(f"""
                INSERT INTO "client_{target_slug}".servers (project_id, hostname, ip_address, status, specs)
                VALUES (:project_id, :hostname, CAST(:ip_address AS inet), :status, CAST(:specs AS jsonb))
                RETURNING id::text, project_id::text, hostname, ip_address::text, status, specs, created_at::text, updated_at::text
            """),
            {
                "project_id": proj_row.id,
                "hostname": req.hostname,
                "ip_address": req.ip_address,
                "status": req.status,
                "specs": json.dumps(req.specs or {})
            }
        )
        row = result.fetchone()
        await db.commit()
        return ServerResponse(
            id=row.id,
            project_id=row.project_id,
            hostname=row.hostname,
            ip_address=row.ip_address,
            status=row.status,
            specs=row.specs or {},
            created_at=row.created_at,
            updated_at=row.updated_at
        )
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        if "unique" in str(exc).lower():
            raise HTTPException(status_code=409, detail=f"Server with hostname '{req.hostname}' already exists")
        raise HTTPException(status_code=500, detail=f"Failed to register server: {exc}")

@router.get("/", response_model=List[ServerResponse])
async def list_servers(
    company_slug: Optional[str] = None,
    include_decommissioned: bool = False,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("server.read"))
):
    """
    Lists servers in the tenant's schema. Servers whose agent was decommissioned are
    hidden unless include_decommissioned=true.
    """
    caller_slug = admin["company_slug"]
    if caller_slug == "global":
        if not company_slug:
            raise HTTPException(status_code=400, detail="Global administrator must target a specific company slug")
        target_slug = company_slug
    else:
        target_slug = caller_slug

    if not re.match(r"^[a-zA-Z0-9_-]+$", target_slug):
        raise HTTPException(status_code=400, detail="Invalid tenant identifier")

    await set_tenant_search_path(db, target_slug)

    try:
        result = await db.execute(
            text(f"""
                SELECT id::text, project_id::text, hostname, ip_address::text, status, specs, created_at::text, updated_at::text
                FROM "client_{target_slug}".servers s
                WHERE :all OR NOT EXISTS (
                    SELECT 1 FROM "client_{target_slug}".sentinel_agents a
                    WHERE a.server_id = s.id AND a.status = 'decommissioned')
                ORDER BY created_at DESC
            """),
            {"all": include_decommissioned},
        )
        rows = result.fetchall()
        return [
            ServerResponse(
                id=row.id,
                project_id=row.project_id,
                hostname=row.hostname,
                ip_address=row.ip_address,
                status=row.status,
                specs=row.specs or {},
                created_at=row.created_at,
                updated_at=row.updated_at
            ) for row in rows
        ]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query servers: {exc}")
