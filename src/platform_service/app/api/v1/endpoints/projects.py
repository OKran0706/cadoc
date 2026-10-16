from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
from typing import Optional, List
import re
from app.core.database import get_db_session, set_tenant_search_path
from app.core.security import RequirePermission

router = APIRouter()

class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    company_slug: Optional[str] = None  # to allow global admins to target a tenant

class ProjectResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    created_at: str
    updated_at: str

@router.post("/", response_model=ProjectResponse)
async def create_project(
    req: ProjectCreate,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("project.manage"))
):
    """
    Creates a new project in the tenant's schema.
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
        result = await db.execute(
            text(f"""
                INSERT INTO "client_{target_slug}".projects (name, description)
                VALUES (:name, :description)
                RETURNING id::text, name, description, created_at::text, updated_at::text
            """),
            {"name": req.name, "description": req.description}
        )
        row = result.fetchone()
        await db.commit()
        return ProjectResponse(
            id=row.id,
            name=row.name,
            description=row.description,
            created_at=row.created_at,
            updated_at=row.updated_at
        )
    except Exception as exc:
        await db.rollback()
        if "unique" in str(exc).lower():
            raise HTTPException(status_code=409, detail=f"Project with name '{req.name}' already exists")
        raise HTTPException(status_code=500, detail=f"Failed to create project: {exc}")

@router.get("/", response_model=List[ProjectResponse])
async def list_projects(
    company_slug: Optional[str] = None,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("project.read"))
):
    """
    Lists all projects in the tenant's schema.
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
                SELECT id::text, name, description, created_at::text, updated_at::text
                FROM "client_{target_slug}".projects
                ORDER BY created_at DESC
            """)
        )
        rows = result.fetchall()
        return [
            ProjectResponse(
                id=row.id,
                name=row.name,
                description=row.description,
                created_at=row.created_at,
                updated_at=row.updated_at
            ) for row in rows
        ]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to query projects: {exc}")
