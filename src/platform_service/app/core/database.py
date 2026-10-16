import logging
import re
import jwt
from fastapi import Request
from typing import Optional
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import text
from app.core.config import settings

logger = logging.getLogger("platform.database")

# Replace postgresql:// with postgresql+asyncpg:// if not already configured
db_url = settings.DATABASE_URL
if db_url.startswith("postgresql://"):
    db_url = db_url.replace("postgresql://", "postgresql+asyncpg://", 1)

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

def _extract_company_slug(request: Optional[Request]) -> Optional[str]:
    """Helper to detect company_slug strictly from JWT Bearer or request headers."""
    if not request:
        return None

    # 1. Inspect Authorization Bearer JWT
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header.removeprefix("Bearer ").strip()
        try:
            payload = jwt.decode(token, options={"verify_signature": False})
            slug = payload.get("company_slug")
            if slug and slug != "global" and re.match(r"^[a-zA-Z0-9_-]+$", str(slug)):
                return str(slug)
        except Exception:
            pass

    # 2. Inspect X-Company-Slug or X-Tenant-Slug header
    header_slug = request.headers.get("X-Company-Slug") or request.headers.get("X-Tenant-Slug")
    if header_slug and header_slug != "global" and re.match(r"^[a-zA-Z0-9_-]+$", str(header_slug)):
        return str(header_slug)

    return None

async def set_tenant_search_path(session: AsyncSession, company_slug: str) -> str:
    """
    Explicitly scopes the database session search_path to client_{company_slug}.
    Directly sets search_path on the active connection so subsequent queries resolve tenant tables.
    """
    if not company_slug or company_slug == "global":
        try:
            await session.execute(text("SET search_path TO public"))
        except Exception:
            pass
        return "public"

    clean_slug = company_slug.strip()
    if not re.match(r"^[a-zA-Z0-9_-]+$", clean_slug):
        raise ValueError(f"Invalid company slug format: {company_slug}")

    schema_name = f"client_{clean_slug}"
    try:
        # Directly set search_path on the connection
        await session.execute(text(f'SET search_path TO "{schema_name}", public'))
        logger.info(f"Switched session search_path directly to: {schema_name}")
        return schema_name
    except Exception as exc:
        logger.error(f"Failed to switch tenant search path to {company_slug}: {exc}")
        raise

async def get_db_session(request: Request = None) -> AsyncSession:
    """
    Yields an AsyncSession automatically scoped to the calling tenant if detected from request context.
    Resets search_path to public on session exit to keep connection pool clean.
    """
    async with async_session_factory() as session:
        schema_name = None
        slug = _extract_company_slug(request)
        if slug:
            schema_name = f"client_{slug}"
            try:
                await session.execute(text(f'SET search_path TO "{schema_name}", public'))
                logger.debug(f"Auto-injected tenant search_path: {schema_name}")
            except Exception as exc:
                logger.warning(f"Could not auto-inject search_path for {schema_name}: {exc}")

        try:
            yield session
        finally:
            if schema_name:
                try:
                    await session.execute(text("SET search_path TO public"))
                except Exception:
                    pass
