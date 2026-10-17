from typing import Any, Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db_session
from app.core.security import RequirePermission
from app.services.forensics.chat import chat
from app.services.forensics.guard import GuardError
from app.services.forensics.runner import ProjectNotFound, run_query

router = APIRouter()
MAX_ROWS = 1000


class QueryReq(BaseModel):
    sql: str = Field(max_length=8000)


class Result(BaseModel):
    columns: list[str] = Field(max_length=50)
    rows: list[list[Any]] = Field(max_length=MAX_ROWS)


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)
    sql: Optional[str] = Field(None, max_length=8000)
    result: Optional[Result] = None


class ChatReq(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def last_is_user(self):
        if self.messages[-1].role != "user":
            raise ValueError("last message must be from the user")
        return self


@router.post("/query")
async def query(
    project_id: UUID,
    req: QueryReq,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("security.read")),
):
    if admin["company_slug"] == "global":
        raise HTTPException(400, "Forensics queries need a tenant-scoped credential")
    try:
        return await run_query(db, admin["company_slug"], str(project_id), req.sql, max_rows=MAX_ROWS)
    except GuardError as e:
        raise HTTPException(400, str(e))
    except ProjectNotFound:
        raise HTTPException(404, "Project not found")
    except SQLAlchemyError as e:
        raise HTTPException(400, f"Query failed: {str(getattr(e, 'orig', e))[:300]}")


@router.post("/chat")
async def forensics_chat(
    project_id: UUID,
    req: ChatReq,
    admin: dict = Depends(RequirePermission("security.read")),
):
    if not settings.GEMINI_API_KEY:
        raise HTTPException(503, "Forensics chat is not configured")
    try:
        return await chat([m.model_dump(exclude_none=True) for m in req.messages], str(project_id))
    except GuardError as e:
        raise HTTPException(422, f"Could not produce a safe query: {e}")
