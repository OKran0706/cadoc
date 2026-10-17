from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
import jwt
import time
import re
import redis.asyncio as redis
from app.core.database import get_db_session
from app.core.security import verify_password
from app.core.config import settings

router = APIRouter()

class LoginRequest(BaseModel):
    email: str
    password: str
    company_slug: str = "global"

class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    role: str = "user"
    roles: List[str] = []

@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest, request: Request, db: AsyncSession = Depends(get_db_session)):
    """
    Authenticates a user against public.global_admins or tenant-local users,
    and returns an active JWT token.
    Supports optional Redis-backed rate-limiting when enabled.
    """
    ip_address = request.client.host if request.client else "unknown"
    
    r = None
    if settings.ENABLE_RATE_LIMIT:
        try:
            r = redis.from_url(settings.REDIS_URL, decode_responses=True)
            
            # Check locks
            ip_lock_key = f"auth:lock:ip:{ip_address}"
            user_lock_key = f"auth:lock:user:{req.email}"
            
            if await r.get(ip_lock_key) or await r.get(user_lock_key):
                raise HTTPException(
                    status_code=429,
                    detail="Too many failed login attempts. Please try again after 15 minutes."
                )
        except HTTPException:
            raise
        except Exception:
            # Gracefully fail-open if Redis is down
            pass

    if req.company_slug == "global":
        result = await db.execute(
            text("SELECT id, email, display_name, password_hash, 'platform_owner' AS role FROM public.global_admins WHERE email = :email AND status = 'active'"),
            {"email": req.email}
        )
        user = result.fetchone()
    else:
        from app.core.database import set_tenant_search_path
        clean_slug = req.company_slug.strip()
        if not re.match(r"^[a-zA-Z0-9_-]+$", clean_slug):
            raise HTTPException(status_code=400, detail="Invalid company slug")

        await set_tenant_search_path(db, clean_slug)
        result = await db.execute(
            text(f"""
                SELECT 
                    u.id, 
                    u.email, 
                    u.display_name, 
                    u.password_hash,
                    (
                        SELECT array_agg(r.name) 
                        FROM "client_{clean_slug}".user_roles ur 
                        JOIN "client_{clean_slug}".roles r ON r.id = ur.role_id 
                        WHERE ur.user_id = u.id
                    ) AS roles
                FROM "client_{clean_slug}".users u 
                WHERE u.email = :email
            """),
            {"email": req.email}
        )
        user = result.fetchone()
    
    is_valid = user and verify_password(req.password, user.password_hash)
    
    if not is_valid:
        if settings.ENABLE_RATE_LIMIT and r:
            try:
                ip_fail_key = f"auth:failed:ip:{ip_address}"
                user_fail_key = f"auth:failed:user:{req.email}"
                
                async with r.pipeline(transaction=True) as pipe:
                    pipe.incr(ip_fail_key)
                    pipe.expire(ip_fail_key, 900)  # 15 minutes TTL
                    pipe.incr(user_fail_key)
                    pipe.expire(user_fail_key, 900)  # 15 minutes TTL
                    results = await pipe.execute()
                
                ip_fails = int(results[0])
                user_fails = int(results[2])
                
                # Lockout on 5 failed attempts
                if ip_fails >= 5:
                    await r.set(f"auth:lock:ip:{ip_address}", "locked", ex=900)
                if user_fails >= 5:
                    await r.set(f"auth:lock:user:{req.email}", "locked", ex=900)
            except Exception:
                pass
                
        raise HTTPException(status_code=401, detail="Invalid admin credentials")
        
    # Clear failed counters and locks on success
    if settings.ENABLE_RATE_LIMIT and r:
        try:
            await r.delete(
                f"auth:failed:ip:{ip_address}",
                f"auth:failed:user:{req.email}",
                f"auth:lock:ip:{ip_address}",
                f"auth:lock:user:{req.email}"
            )
        except Exception:
            pass

    # Resolve user role(s)
    if req.company_slug == "global":
        role_attr = getattr(user, "role", None)
        roles_attr = getattr(user, "roles", None)
        if isinstance(role_attr, str) and role_attr:
            user_role = role_attr
            user_roles = [role_attr]
        elif isinstance(roles_attr, (list, tuple)) and roles_attr:
            user_roles = [str(r) for r in roles_attr if r]
            user_role = user_roles[0] if user_roles else "platform_owner"
        else:
            user_role = "platform_owner"
            user_roles = ["platform_owner"]
    else:
        roles_attr = getattr(user, "roles", None)
        role_attr = getattr(user, "role", None)
        if isinstance(roles_attr, (list, tuple)) and roles_attr:
            user_roles = [str(r) for r in roles_attr if r]
            user_role = user_roles[0] if user_roles else "user"
        elif isinstance(role_attr, str) and role_attr:
            user_role = role_attr
            user_roles = [role_attr]
        else:
            user_role = "user"
            user_roles = ["user"]

    payload = {
        "sub": str(user.id),
        "email": user.email,
        "name": user.display_name,
        "company_slug": req.company_slug,
        "role": user_role,
        "roles": user_roles,
        "iat": int(time.time()),
        "exp": int(time.time()) + (settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60)
    }
    
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    return TokenResponse(
        access_token=token,
        token_type="bearer",
        role=user_role,
        roles=user_roles
    )
