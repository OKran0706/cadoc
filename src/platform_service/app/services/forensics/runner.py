from sqlalchemy import text

from app.core.database import set_tenant_search_path
from app.services.forensics.guard import guard_sql


class ProjectNotFound(LookupError):
    pass


async def run_query(db, slug: str, project_id: str, sql: str, max_rows: int = 1000) -> dict:
    guarded = guard_sql(sql, project_id, max_rows=max_rows)  # raises GuardError before any DB work
    await set_tenant_search_path(db, slug)
    try:
        found = await db.execute(text("SELECT 1 FROM projects WHERE id = :pid"), {"pid": project_id})
        if found.fetchone() is None:
            raise ProjectNotFound(project_id)
        await db.execute(text("SET LOCAL transaction_read_only = on"))
        await db.execute(text("SET LOCAL statement_timeout = '5s'"))
        # "\:" stops text() from reading ':name' inside string literals as a bind parameter.
        res = await db.execute(text(guarded.replace(":", "\\:")))
        rows = [list(r) for r in res.fetchall()]
        return {"columns": list(res.keys()), "rows": rows, "truncated": len(rows) >= max_rows}
    finally:
        await db.rollback()
