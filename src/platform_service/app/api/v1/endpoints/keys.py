from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
from typing import Optional, List
import secrets
import hashlib
from datetime import datetime, timedelta, timezone
from app.core.database import get_db_session
from app.core.security import RequirePermission

router = APIRouter()

class APIKeyCreate(BaseModel):
    name: str
    expires_in_days: Optional[int] = None

class APIKeyResponse(BaseModel):
    id: str
    name: str
    created_at: str
    expires_at: Optional[str] = None
    revoked_at: Optional[str] = None

class APIKeyCreateResponse(BaseModel):
    id: str
    name: str
    plain_text_key: str
    created_at: str
    expires_at: Optional[str] = None

@router.post("/", response_model=APIKeyCreateResponse)
async def create_api_key(
    req: APIKeyCreate,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("admin.manage"))
):
    """
    Generates a new programmatic API Key, hashes it with SHA-256 to save,
    and returns the plain-text key once.
    """
    user_id = admin["user_id"]
    
    # 1. Generate secure random API key
    raw_key = f"cadoc_live_{secrets.token_hex(24)}"
    hashed_key = hashlib.sha256(raw_key.encode()).hexdigest()
    
    # Calculate expiration
    expires_at = None
    if req.expires_in_days is not None:
        expires_at = datetime.now(timezone.utc) + timedelta(days=req.expires_in_days)
    
    try:
        result = await db.execute(
            text("""
                INSERT INTO public.admin_api_keys (admin_user_id, name, key_hash, expires_at)
                VALUES (:user_id, :name, :key_hash, :expires_at)
                RETURNING id, created_at::text, expires_at::text
            """),
            {
                "user_id": user_id,
                "name": req.name,
                "key_hash": hashed_key,
                "expires_at": expires_at
            }
        )
        row = result.fetchone()
        await db.commit()
        
        return APIKeyCreateResponse(
            id=str(row.id),
            name=req.name,
            plain_text_key=raw_key,
            created_at=row.created_at,
            expires_at=row.expires_at
        )
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to generate API Key: {exc}")

@router.get("/", response_model=List[APIKeyResponse])
async def list_api_keys(
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("admin.manage"))
):
    """
    Lists metadata of active, expired, or revoked keys for the authenticated user.
    """
    user_id = admin["user_id"]
    result = await db.execute(
        text("""
            SELECT id, name, created_at::text, expires_at::text, revoked_at::text
            FROM public.admin_api_keys
            WHERE admin_user_id = :user_id
            ORDER BY created_at DESC
        """),
        {"user_id": user_id}
    )
    rows = result.fetchall()
    
    return [
        APIKeyResponse(
            id=str(row.id),
            name=row.name,
            created_at=row.created_at,
            expires_at=row.expires_at,
            revoked_at=row.revoked_at
        ) for row in rows
    ]

@router.delete("/{key_id}")
async def revoke_api_key(
    key_id: str,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("admin.manage"))
):
    """
    Revokes the specified programmatic API key.
    """
    user_id = admin["user_id"]
    try:
        result = await db.execute(
            text("""
                UPDATE public.admin_api_keys
                SET revoked_at = now()
                WHERE id = :key_id AND admin_user_id = :user_id AND revoked_at IS NULL
            """),
            {"key_id": key_id, "user_id": user_id}
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="API Key not found or already revoked")
        await db.commit()
        return {"status": "success", "message": "API Key successfully revoked"}
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to revoke API Key: {exc}")
