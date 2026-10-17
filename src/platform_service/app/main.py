import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from app.core.config import settings
from app.api.v1.endpoints import auth, onboarding, bootstrap, dashboard, keys, decoys, agents, admins, projects, servers, internal, forensics
from app.services.liveness import listen_redis_heartbeat_expirations
from app.services.event_writer import run_event_writer

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Launch the async Redis Keyspace expiration observer task
    liveness_task = asyncio.create_task(listen_redis_heartbeat_expirations())
    writer_task = asyncio.create_task(run_event_writer())
    
    # Run dynamic admin bootstrapping if env vars are present
    if settings.INITIAL_ADMIN_EMAIL and settings.INITIAL_ADMIN_PASSWORD:
        from app.core.database import async_session_factory
        from app.core.security import get_password_hash, verify_password_strength
        import logging
        logger = logging.getLogger("platform.bootstrap")
        
        try:
            # Enforce password strength first
            verify_password_strength(settings.INITIAL_ADMIN_PASSWORD)
            
            async with async_session_factory() as session:
                async with session.begin():
                    # Check if user already exists
                    chk_res = await session.execute(
                        text("SELECT id FROM public.global_admins WHERE email = :email"),
                        {"email": settings.INITIAL_ADMIN_EMAIL}
                    )
                    row = chk_res.fetchone()
                    
                    hashed = get_password_hash(settings.INITIAL_ADMIN_PASSWORD)
                    if row:
                        user_id = row.id
                        # Update password
                        await session.execute(
                            text("""
                                UPDATE public.global_admins 
                                SET password_hash = :hash, updated_at = now()
                                WHERE id = :user_id
                            """),
                            {"hash": hashed, "user_id": user_id}
                        )
                        logger.info(f"✓ Dynamic admin bootstrap: updated password for {settings.INITIAL_ADMIN_EMAIL}")
                    else:
                        # Insert admin user
                        ins_res = await session.execute(
                            text("""
                                INSERT INTO public.global_admins (email, display_name, status, password_hash)
                                VALUES (:email, 'Bootstrap Administrator', 'active', :hash)
                                RETURNING id
                            """),
                            {"email": settings.INITIAL_ADMIN_EMAIL, "hash": hashed}
                        )
                        user_id = ins_res.scalar()
                        logger.info(f"✓ Dynamic admin bootstrap: created user {settings.INITIAL_ADMIN_EMAIL}")
        except Exception as exc:
            logger.error(f"❌ Failed to run administrative bootstrapping on startup: {exc}")

    yield
    # Shutdown: Cancel background tasks
    liveness_task.cancel()
    writer_task.cancel()
    await asyncio.gather(liveness_task, writer_task, return_exceptions=True)

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
app.include_router(keys.router, prefix="/api/v1/keys", tags=["keys"])
app.include_router(decoys.router, prefix="/api/v1/decoys", tags=["decoys"])
app.include_router(agents.router, prefix="/api/v1/agents", tags=["agents"])
app.include_router(admins.router, prefix="/api/v1/admins", tags=["admins"])
app.include_router(projects.router, prefix="/api/v1/projects", tags=["projects"])
app.include_router(forensics.router, prefix="/api/v1/projects/{project_id}/forensics", tags=["forensics"])
app.include_router(servers.router, prefix="/api/v1/servers", tags=["servers"])
app.include_router(internal.router, prefix="/internal/v1", tags=["internal"])

@app.get("/health")
def health_check():
    return {"status": "healthy", "service": settings.PROJECT_NAME}
