from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel, EmailStr
import jwt
import time
from app.core.database import get_db_session
from app.core.security import verify_password
from app.core.config import settings

router = APIRouter()

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str

@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest, db: AsyncSession = Depends(get_db_session)):
    """
    Authenticates a user against public.admin_users and retrieves their global
    role mapping or tenant company slug. Returns an active JWT token.
    """
    result = await db.execute(
        text("SELECT id, email, display_name, password_hash FROM public.admin_users WHERE email = :email AND status = 'active'"),
        {"email": req.email}
    )
    user = result.fetchone()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid admin credentials")
    
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
