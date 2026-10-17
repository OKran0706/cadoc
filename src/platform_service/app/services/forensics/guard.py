"""SQL guard for the Forensics tab: parse, allow-list, and project-scope.

This is the only project boundary (hackathon scope: no views/role). The runner must also use
a READ ONLY txn with search_path = the tenant schema and a statement_timeout.
Allow-lists, not deny-lists: anything not named here is rejected.
"""
import uuid

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError

# Every table is rewritten to a project-filtered subquery. project_id lives only on servers.
_VIA_SERVER = "SELECT t.* FROM {t} t JOIN servers s ON s.id = t.server_id WHERE s.project_id = '{p}'"
SCOPES = {
    "servers": "SELECT * FROM servers WHERE project_id = '{p}'",
    "tamper_alerts": _VIA_SERVER.replace("{t}", "tamper_alerts"),
    "sentinel_agents": _VIA_SERVER.replace("{t}", "sentinel_agents"),
    "canary_decoy_files": _VIA_SERVER.replace("{t}", "canary_decoy_files"),
    # No server_id of its own: scoped through the alert it mitigates.
    "alert_mitigations": "SELECT m.* FROM alert_mitigations m JOIN tamper_alerts a ON a.id = m.alert_id "
                         "JOIN servers s ON s.id = a.server_id WHERE s.project_id = '{p}'",
}

# Function names are sqlglot's normalized sql_name() (Anonymous funcs use the raw name).
FUNCTIONS = {
    "COUNT", "SUM", "MIN", "MAX", "AVG", "COALESCE", "NULLIF", "LOWER", "UPPER", "LENGTH",
    "SUBSTRING", "TRIM", "CONCAT", "CAST", "TRY_CAST", "IF", "CASE", "ROUND", "ABS",
    "EXTRACT", "DATE_TRUNC", "TIMESTAMP_TRUNC", "NOW", "CURRENT_TIMESTAMP", "CURRENT_DATE",
    "JSON_EXTRACT", "JSON_EXTRACT_SCALAR", "JSONB_EXTRACT_PATH_TEXT",
    "ROW_NUMBER", "RANK", "DENSE_RANK", "LAG", "LEAD", "STRING_AGG", "ARRAY_AGG",
    "TO_CHAR", "DATE_DIFF", "DATEDIFF", "TIMESTAMP_DIFF", "SPLIT_PART", "REGEXP_LIKE",
    "COUNT_IF", "ANY_VALUE", "LEAST", "GREATEST",
}

FORBIDDEN_NODES = (
    exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Create, exp.Drop, exp.AlterTable,
    exp.Command, exp.Set, exp.Copy, exp.Into, exp.Lock, exp.Transaction,
)


class GuardError(ValueError):
    pass


def _fn_name(node: exp.Func) -> str:
    name = node.name if isinstance(node, exp.Anonymous) else node.sql_name()
    return name.upper()


def _inside(node: exp.Expression, ancestor: exp.Expression) -> bool:
    while node is not None:
        if node is ancestor:
            return True
        node = node.parent
    return False


def guard_sql(sql: str, project_id: str, *, max_rows: int = 1000) -> str:
    try:
        pid = str(uuid.UUID(str(project_id)))  # canonical form: safe to inline in SQL
    except ValueError as e:
        raise GuardError("invalid project id") from e
    try:
        stmts = sqlglot.parse(sql, dialect="postgres")
    except SqlglotError as e:
        raise GuardError(f"unparseable SQL: {e}") from e
    stmts = [s for s in stmts if s is not None]
    if len(stmts) != 1:
        raise GuardError("exactly one statement required")
    tree = stmts[0]
    if not isinstance(tree, exp.Query):
        raise GuardError("only SELECT queries allowed")

    ctes = {c.alias_or_name: c for c in tree.find_all(exp.CTE)}
    uses_alerts = False
    scoped = []
    for node in tree.walk():
        node = node[0] if isinstance(node, tuple) else node
        if isinstance(node, FORBIDDEN_NODES):
            raise GuardError(f"{type(node).__name__} not allowed")
        if isinstance(node, exp.Func) and _fn_name(node) not in FUNCTIONS:
            raise GuardError(f"function not allowed: {_fn_name(node)}")
        if isinstance(node, exp.Table):
            if isinstance(node.this, exp.Func):  # table function in FROM
                continue  # the Func branch above already vetted/rejected it
            name, db = node.name.lower(), node.db.lower()
            cte = ctes.get(node.name)
            # CTE ref is fine unless it sits inside its own body (that resolves to a real table).
            # Out-of-order sibling refs fall through to the DB layer (search_path=forensics only).
            if cte and not db and not _inside(node, cte):
                continue
            if node.catalog or db or name not in SCOPES:
                raise GuardError(f"relation not allowed: {node.sql()}")
            uses_alerts |= name == "tamper_alerts"
            scoped.append(node)

    # Partitioned on detected_at; unbounded scans over alerts are refused so the AI/user must window.
    if uses_alerts and not any(
        c.name == "detected_at" for w in tree.find_all(exp.Where) for c in w.find_all(exp.Column)
    ):
        raise GuardError("queries on tamper_alerts must filter detected_at in WHERE")

    for node in scoped:
        sub = sqlglot.parse_one(SCOPES[node.name.lower()].format(p=pid), dialect="postgres").subquery(
            alias=node.alias or node.name)
        node.replace(sub)

    inner = tree.sql(dialect="postgres", comments=False)
    return f"SELECT * FROM ({inner}) AS _guarded LIMIT {int(max_rows)}"
