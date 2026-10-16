import time
import jwt
import hashlib
import redis.asyncio as redis
import re
from passlib.context import CryptContext
from fastapi import HTTPException, Security, Request, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials, APIKeyHeader
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.core.config import settings
from app.core.database import get_db_session, set_tenant_search_path

pwd_context = CryptContext(schemes=["sha256_crypt", "bcrypt"], deprecated="auto")
security_bearer = HTTPBearer(auto_error=False)
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def verify_password_strength(password: str) -> None:
    """
    Enforces production-ready password complexity/entropy guidelines.
    Raises HTTPException (400 Bad Request) if password is weak.
    """
    if len(password) < 12:
        raise HTTPException(
            status_code=400,
            detail="Password must be at least 12 characters long"
        )
    if not re.search(r"[A-Z]", password):
        raise HTTPException(
            status_code=400,
            detail="Password must contain at least one uppercase letter"
        )
    if not re.search(r"[a-z]", password):
        raise HTTPException(
            status_code=400,
            detail="Password must contain at least one lowercase letter"
        )
    if not re.search(r"[0-9]", password):
        raise HTTPException(
            status_code=400,
            detail="Password must contain at least one numeric digit"
        )
    if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", password):
        raise HTTPException(
            status_code=400,
            detail="Password must contain at least one special character (e.g. !@#$%^&*)"
        )

def verify_user_jwt(credentials: HTTPAuthorizationCredentials = Security(security_bearer)) -> dict:
    """
    Decodes and verifies an administrative login User JWT.
    Validates expiration, signatures, and company claims.
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Missing administrative credentials")
    try:
        token = credentials.credentials
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        
        # Ensure company_slug is embedded in claims
        if "company_slug" not in payload:
            raise HTTPException(status_code=401, detail="Missing company_slug claim in JWT payload")
        
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Administrative JWT signature has expired")
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid user administrative token: {exc}")

def mint_sentinel_join_token(client_id: str, server_id: str) -> str:
    """
    Generates a signed one-time-use Join Token for a Sentinel agent.
    Signs the payload with BOOTSTRAP_JWT_SECRET.
    """
    import uuid
    now = int(time.time())
    payload = {
        "sub": "sentinel-bootstrap",
        "client_id": client_id,
        "server_id": server_id,
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + 900  # 15 minutes TTL
    }
    return jwt.encode(payload, settings.BOOTSTRAP_JWT_SECRET, algorithm=settings.JWT_ALGORITHM)

class RequirePermission:
    def __init__(self, permission_code: str):
        self.permission_code = permission_code

    async def __call__(
        self,
        request: Request,
        db: AsyncSession = Depends(get_db_session),
        api_key: str = Depends(api_key_header),
        credentials: HTTPAuthorizationCredentials = Depends(security_bearer)
    ) -> dict:
        user_id = None
        company_slug = None

        # 1. Try Bearer JWT Authentication
        if credentials:
            try:
                claims = verify_user_jwt(credentials)
                user_id = claims["sub"]
                company_slug = claims["company_slug"]
            except HTTPException as exc:
                raise exc
        # 2. Try X-API-Key Authentication
        elif api_key:
            if api_key.startswith("cadoc_g_"):
                raw_secret = api_key.removeprefix("cadoc_g_")
                hashed_key = hashlib.sha256(raw_secret.encode()).hexdigest()
                res = await db.execute(
                    text("""
                        SELECT id, admin_id 
                        FROM public.global_api_keys 
                        WHERE key_hash = :hash AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
                    """),
                    {"hash": hashed_key}
                )
                key_row = res.fetchone()
                if not key_row:
                    raise HTTPException(status_code=401, detail="Invalid or revoked API Key")
                
                user_id = str(key_row.admin_id)
                company_slug = "global"
            elif api_key.startswith("cadoc_t_"):
                remaining = api_key.removeprefix("cadoc_t_")
                if "_" not in remaining:
                    raise HTTPException(status_code=401, detail="Invalid or revoked API Key")
                company_slug, raw_secret = remaining.split("_", 1)
                hashed_key = hashlib.sha256(raw_secret.encode()).hexdigest()
                
                # Switch search path to target tenant
                await set_tenant_search_path(db, company_slug)
                
                res = await db.execute(
                    text("""
                        SELECT id, user_id 
                        FROM api_keys 
                        WHERE key_hash = :hash AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
                    """),
                    {"hash": hashed_key}
                )
                key_row = res.fetchone()
                if not key_row:
                    raise HTTPException(status_code=401, detail="Invalid or revoked API Key")
                
                user_id = str(key_row.user_id)
            else:
                raise HTTPException(status_code=401, detail="Invalid or revoked API Key")
        else:
            raise HTTPException(status_code=401, detail="Missing administrative credentials")

        # 3. Resolve Tenant UUID
        tenant_id = None
        if company_slug != "global":
            t_res = await db.execute(
                text("SELECT id FROM public.tenants WHERE slug = :slug AND status = 'active'"),
                {"slug": company_slug}
            )
            t_row = t_res.fetchone()
            if not t_row:
                raise HTTPException(status_code=403, detail="Inactive or missing tenant schema context")
            tenant_id = t_row.id

        # 4. Check Cache & Dynamic Permissions
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        cache_key = f"rbac:permission:{user_id}:{self.permission_code}:{tenant_id}"
        
        try:
            cached_val = await r.get(cache_key)
            if cached_val is not None:
                if cached_val == "true":
                    return {"user_id": user_id, "company_slug": company_slug, "tenant_id": tenant_id}
                raise HTTPException(status_code=403, detail="Insufficient administrative permissions")
        except Exception:
            pass

        if company_slug == "global":
            admin_res = await db.execute(
                text("SELECT 1 FROM public.global_admins WHERE id = :user_id AND status = 'active'"),
                {"user_id": user_id}
            )
            has_perm = admin_res.fetchone() is not None
        else:
            perm_res = await db.execute(
                text("""
                    SELECT EXISTS (
                        SELECT 1 
                        FROM user_roles ur
                        JOIN roles r ON r.id = ur.role_id
                        WHERE ur.user_id = :user_id
                          AND r.permissions ? :code
                    )
                """),
                {"user_id": user_id, "code": self.permission_code}
            )
            has_perm = perm_res.scalar()
        
        try:
            await r.set(cache_key, "true" if has_perm else "false", ex=60)
        except Exception:
            pass
            
        if not has_perm:
            raise HTTPException(status_code=403, detail="Insufficient administrative permissions")

        return {"user_id": user_id, "company_slug": company_slug, "tenant_id": tenant_id}

