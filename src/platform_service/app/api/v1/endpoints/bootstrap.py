from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
import logging
from app.core.database import get_db_session, set_tenant_search_path
from app.core.security import verify_user_jwt, mint_sentinel_join_token

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
        client_id = f"sentinel-agent-{company_slug}"
        token = mint_sentinel_join_token(client_id, req.server_id)
        
        logger.info(f"Brokered Join Token minted: server_id={req.server_id} for client={company_slug}")
        return {"status": "success", "join_token": token, "client_id": client_id}
    
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Control plane brokering error: {str(exc)}")
