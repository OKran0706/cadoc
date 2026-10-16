from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
import logging
from app.core.database import get_db_session, set_tenant_search_path
from app.core.security import verify_user_jwt, mint_sentinel_join_token
from app.core.install import build_install_command, ca_sha256

logger = logging.getLogger("platform.bootstrap")
router = APIRouter()

class JoinRequest(BaseModel):
    server_id: str

@router.post("/join")
async def brokered_join(req: JoinRequest, db: AsyncSession = Depends(get_db_session), admin_claims: dict = Depends(verify_user_jwt)):
    """
    Administrative Brokered Join. Verifies user-login JWT, targets tenant company_slug,
    verifies target server identity within that client schema, and mints Sentinel Join Token.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Ambiguous context: global administrator must target a specific company slug")
    
    # Dynamic search_path targeting
    await set_tenant_search_path(db, company_slug)

    # Confirm server exists inside tenant inventory
    try:
        server_res = await db.execute(
            text("SELECT id, hostname FROM servers WHERE id = :server_id"),
            {"server_id": req.server_id}
        )
        server = server_res.fetchone()
        if not server:
            raise HTTPException(status_code=404, detail=f"Server ID {req.server_id} not registered for client {company_slug}")
        
        # Mint token
        # client_id = {company_slug}.{sentinel_id}: the format ingestion's renewal path splits on.
        client_id = f"{company_slug}.{req.server_id}"
        token = mint_sentinel_join_token(company_slug, req.server_id)

        logger.info(f"Brokered Join Token minted: server_id={req.server_id} for client={company_slug}")
        return {
            "status": "success",
            "join_token": token,
            "client_id": client_id,
            "install_command": build_install_command(token, client_id),
            "ca_sha256": ca_sha256(),
        }
    
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Control plane brokering error: {str(exc)}")
