import os
import httpx
from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.responses import PlainTextResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

app = FastAPI(title="Secure Onboarding API", version="1.1.0")
security = HTTPBearer()

class DeployRequest(BaseModel):
    server_id: str

def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    expected_token = os.getenv("API_AUTH_TOKEN")
    if expected_token:
        if credentials.credentials != expected_token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token",
                headers={"WWW-Authenticate": "Bearer"},
            )
    return credentials.credentials

async def create_scoped_token(server_id: str) -> str:
    vault_addr = os.getenv("VAULT_ADDR")
    if not vault_addr:
        raise ValueError("VAULT_ADDR environment variable is required")

    app_token = os.getenv("VAULT_TOKEN")
    if not app_token:
        raise ValueError("VAULT_TOKEN environment variable is required")

    url = f"{vault_addr}/v1/auth/token/create"

    payload = {
        "policies": ["canary-sentinel-policy"],
        "meta": {"server_id": server_id},
        "ttl": "1h"
    }
    
    headers = {
        "X-Vault-Token": app_token,
        "Content-Type": "application/json"
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(url, json=payload, headers=headers)
        if response.status_code != 200:
            raise Exception(f"Vault returned status {response.status_code}: {response.text}")
        
        data = response.json()
        return data["auth"]["client_token"]

@app.post("/v1/onboard", response_class=PlainTextResponse)
async def onboard(req: DeployRequest, token: str = Depends(verify_token)):
    if not req.server_id:
        raise HTTPException(status_code=400, detail="server_id is required")

    try:
        scoped_token = await create_scoped_token(req.server_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error during token generation: {str(e)}")

    download_url = os.getenv("CANARY_DOWNLOAD_URL", "https://canary-binary-store/sentinel")
    
    command = (
        f"curl -sL {download_url} -o /tmp/sentinel && "
        f"chmod +x /tmp/sentinel && "
        f"VAULT_TOKEN={scoped_token} /tmp/sentinel -id {req.server_id}\n"
    )
    
    return command

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8080))
    print(f"Secure Onboarding API starting on :{port}...")
    uvicorn.run(app, host="0.0.0.0", port=port)
