from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
from app.core.database import get_db_session
from app.core.security import verify_user_jwt

router = APIRouter()

class OnboardRequest(BaseModel):
    slug: str
    name: str

@router.post("/provision")
async def provision_tenant(req: OnboardRequest, db: AsyncSession = Depends(get_db_session), admin_claims: dict = Depends(verify_user_jwt)):
    """
    Provisions a new client tenant by invoking public.provision_tenant SQL routine,
    setting up the client schema, configurations, and partitioned telemetry tables.
    Only allows users with global (platform_owner) rights.
    """
    if admin_claims["company_slug"] != "global":
        raise HTTPException(status_code=403, detail="Administrative scope mismatch: Provisioning requires platform credentials")
    
    try:
        result = await db.execute(
            text("SELECT public.provision_tenant(:slug, :name)"),
            {"slug": req.slug, "name": req.name}
        )
        tenant_id = result.scalar()
        await db.commit()
        return {"status": "success", "tenant_id": str(tenant_id), "schema": f"client_{req.slug}"}
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"Failed to onboard client: {str(exc)}")
