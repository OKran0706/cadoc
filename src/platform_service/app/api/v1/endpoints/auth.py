from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
import jwt
import time
import redis.asyncio as redis
from app.core.database import get_db_session
from app.core.security import verify_password
from app.core.config import settings

router = APIRouter()

class LoginRequest(BaseModel):
    email: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str

@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest, request: Request, db: AsyncSession = Depends(get_db_session)):
    """
    Authenticates a user against public.admin_users and retrieves their global
    role mapping or tenant company slug. Returns an active JWT token.
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

    # Query corresponding user in public.admin_users
    result = await db.execute(
        text("SELECT id, email, display_name, password_hash FROM public.admin_users WHERE email = :email AND status = 'active'"),
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
            
    # Query corresponding company slug
    tenant_result = await db.execute(
        text("""
            SELECT t.slug 
            FROM public.admin_user_roles aur
            JOIN public.tenants t ON t.id = aur.tenant_id
            WHERE aur.admin_user_id = :user_id LIMIT 1
        """),
        {"user_id": user.id}
    )
    tenant_row = tenant_result.fetchone()
    company_slug = tenant_row.slug if tenant_row else "global"

    payload = {
        "sub": str(user.id),
        "email": user.email,
        "name": user.display_name,
        "company_slug": company_slug,
        "iat": int(time.time()),
        "exp": int(time.time()) + (settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60)
    }
    
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    return TokenResponse(access_token=token, token_type="bearer")
