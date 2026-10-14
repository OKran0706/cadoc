import logging
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import text
from app.core.config import settings

logger = logging.getLogger("platform.database")

# Replace postgresql:// with postgresql+asyncpg:// if not already configured
db_url = settings.DATABASE_URL
if db_url.startswith("postgresql://"):
    db_url = db_url.replace("postgresql://", "postgresql+asyncpg://", 1)

print("DATABASE CONNECTION URL BEING USED:", db_url)

engine = create_async_engine(
    db_url,
    pool_size=20,
    max_overflow=10,
    pool_pre_ping=True
)

async_session_factory = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False
)

async def get_db_session() -> AsyncSession:
    """Yield a database session bound to the transaction pool."""
    async with async_session_factory() as session:
        yield session

async def set_tenant_search_path(session: AsyncSession, company_slug: str) -> str:
    """
    Executes public.set_tenant_search_path within the current transaction session
    to scope all subsequent operations to client_{company_slug}.
    """
    try:
        # Calls our custom SQL migration routing helper
        result = await session.execute(
            text("SELECT public.set_tenant_search_path(:slug)"),
            {"slug": company_slug}
        )
        schema_name = result.scalar()
        logger.info(f"Set session search path to: {schema_name}")
        return schema_name
    except Exception as exc:
        logger.error(f"Failed to switch tenant search path to {company_slug}: {exc}")
        raise
