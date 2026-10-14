import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.api.v1.endpoints import auth, onboarding, bootstrap, dashboard
from app.services.liveness import listen_redis_heartbeat_expirations

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Launch the async Redis Keyspace expiration observer task
    liveness_task = asyncio.create_task(listen_redis_heartbeat_expirations())
    yield
    # Shutdown: Cancel background tasks
    liveness_task.cancel()
    await asyncio.gather(liveness_task, return_exceptions=True)

app = FastAPI(
    title=settings.PROJECT_NAME,
    version="1.0.0",
    lifespan=lifespan
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(onboarding.router, prefix="/api/v1/onboarding", tags=["onboarding"])
app.include_router(bootstrap.router, prefix="/api/v1/bootstrap", tags=["bootstrap"])
app.include_router(dashboard.router, prefix="/api/v1/dashboard", tags=["dashboard"])

@app.get("/health")
def health_check():
    return {"status": "healthy", "service": settings.PROJECT_NAME}
