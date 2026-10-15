"""
Administrative control-plane endpoints — user management, RBAC, audit logs,
and cross-client Cadoc telemetry observability.

All endpoints require at minimum an authenticated admin session.
Permission codes are enforced per-route via RequirePermission.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
from typing import Optional, List
from app.core.database import get_db_session
from app.core.security import RequirePermission, get_password_hash, verify_password_strength
import logging

logger = logging.getLogger("platform.admins")
router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic Models
# ---------------------------------------------------------------------------

class AdminUserCreate(BaseModel):
    email: str
    display_name: str
    password: str

class AdminUserResponse(BaseModel):
    id: str
    email: str
    display_name: str
    status: str
    auth_provider: str
    created_at: str
    roles: List[str] = []

class AdminStatusUpdate(BaseModel):
    status: str  # 'active' | 'disabled' | 'invited'

class RoleAssignRequest(BaseModel):
    role_name: str
    company_slug: Optional[str] = None  # None = global, slug = tenant-scoped


# ---------------------------------------------------------------------------
# Admin User Management
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[AdminUserResponse])
async def list_admins(
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("admin.manage"))
):
    """
    Lists all administrative users joined with their assigned roles.
    """
    result = await db.execute(text("""
        SELECT
            au.id::text,
            au.email,
            au.display_name,
            au.status,
            au.auth_provider,
            au.created_at::text,
            COALESCE(
                array_agg(ar.name ORDER BY ar.name) FILTER (WHERE ar.name IS NOT NULL),
                ARRAY[]::text[]
            ) AS roles
        FROM public.admin_users au
        LEFT JOIN public.admin_user_roles aur ON aur.admin_user_id = au.id
        LEFT JOIN public.admin_roles ar ON ar.id = aur.role_id
        GROUP BY au.id, au.email, au.display_name, au.status, au.auth_provider, au.created_at
        ORDER BY au.created_at DESC
    """))
    rows = result.fetchall()
    return [
        AdminUserResponse(
            id=row.id,
            email=row.email,
            display_name=row.display_name,
            status=row.status,
            auth_provider=row.auth_provider,
            created_at=row.created_at,
            roles=list(row.roles) if row.roles else []
        ) for row in rows
    ]


@router.post("/", response_model=AdminUserResponse)
async def create_admin(
    req: AdminUserCreate,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("admin.manage"))
):
    """
    Provisions a new local admin user. Enforces password strength before hashing.
    """
    verify_password_strength(req.password)
    hashed = get_password_hash(req.password)
    try:
        result = await db.execute(
            text("""
                INSERT INTO public.admin_users (email, display_name, status, auth_provider, password_hash)
                VALUES (:email, :display_name, 'active', 'local', :hash)
                RETURNING id::text, email, display_name, status, auth_provider, created_at::text
            """),
            {"email": req.email, "display_name": req.display_name, "hash": hashed}
        )
        row = result.fetchone()
        await db.commit()
        logger.info(f"Admin user created: {req.email} by {admin['user_id']}")
        return AdminUserResponse(
            id=row.id, email=row.email, display_name=row.display_name,
            status=row.status, auth_provider=row.auth_provider,
            created_at=row.created_at, roles=[]
        )
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        if "unique" in str(exc).lower():
            raise HTTPException(status_code=409, detail=f"Admin with email '{req.email}' already exists")
        raise HTTPException(status_code=500, detail=f"Failed to create admin: {exc}")


@router.patch("/{admin_id}/status")
async def update_admin_status(
    admin_id: str,
    req: AdminStatusUpdate,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("admin.manage"))
):
    """
    Updates an admin user's status. Blocks self-lockout for safety.
    """
    valid_statuses = {"active", "disabled", "invited"}
    if req.status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}")

    if admin_id == admin["user_id"] and req.status == "disabled":
        raise HTTPException(status_code=400, detail="Cannot disable your own account — self-lockout prevented")

    try:
        result = await db.execute(
            text("""
                UPDATE public.admin_users SET status = :status, updated_at = now()
                WHERE id = :admin_id RETURNING id
            """),
            {"admin_id": admin_id, "status": req.status}
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Admin user not found")
        await db.commit()
        logger.info(f"Admin {admin_id} status → {req.status} by {admin['user_id']}")
        return {"status": "success", "message": f"Admin status updated to '{req.status}'"}
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to update status: {exc}")


# ---------------------------------------------------------------------------
# Role & Permission Registry
# ---------------------------------------------------------------------------

@router.get("/roles")
async def list_roles(
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("admin.manage"))
):
    """
    Lists all available administrative roles with their assigned permissions.
    """
    result = await db.execute(text("""
        SELECT
            ar.id::text,
            ar.name,
            ar.scope,
            ar.description,
            COALESCE(
                array_agg(ap.code ORDER BY ap.code) FILTER (WHERE ap.code IS NOT NULL),
                ARRAY[]::text[]
            ) AS permissions
        FROM public.admin_roles ar
        LEFT JOIN public.admin_role_permissions arp ON arp.role_id = ar.id
        LEFT JOIN public.admin_permissions ap ON ap.id = arp.permission_id
        GROUP BY ar.id, ar.name, ar.scope, ar.description
        ORDER BY ar.scope, ar.name
    """))
    rows = result.fetchall()
    return [
        {
            "id": row.id,
            "name": row.name,
            "scope": row.scope,
            "description": row.description,
            "permissions": list(row.permissions) if row.permissions else []
        } for row in rows
    ]


@router.post("/{admin_id}/roles")
async def assign_role(
    admin_id: str,
    req: RoleAssignRequest,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("admin.manage"))
):
    """
    Assigns a role to an admin. Supply company_slug for tenant-scoped roles, omit for global.
    """
    # Resolve role
    role_res = await db.execute(
        text("SELECT id, scope FROM public.admin_roles WHERE name = :name"),
        {"name": req.role_name}
    )
    role_row = role_res.fetchone()
    if not role_row:
        raise HTTPException(status_code=404, detail=f"Role '{req.role_name}' not found")

    # Resolve tenant_id if scoped
    tenant_id = None
    if req.company_slug:
        t_res = await db.execute(
            text("SELECT id FROM public.tenants WHERE slug = :slug"),
            {"slug": req.company_slug}
        )
        t_row = t_res.fetchone()
        if not t_row:
            raise HTTPException(status_code=404, detail=f"Tenant '{req.company_slug}' not found")
        tenant_id = t_row.id

    # Enforce scope consistency
    if role_row.scope == "global" and tenant_id is not None:
        raise HTTPException(status_code=400, detail="Global roles must not specify a company_slug")
    if role_row.scope == "tenant" and tenant_id is None:
        raise HTTPException(status_code=400, detail="Tenant-scoped roles require a company_slug")

    try:
        result = await db.execute(
            text("""
                INSERT INTO public.admin_user_roles (admin_user_id, role_id, tenant_id)
                VALUES (:user_id, :role_id, :tenant_id)
                RETURNING id::text
            """),
            {"user_id": admin_id, "role_id": role_row.id, "tenant_id": tenant_id}
        )
        row = result.fetchone()
        await db.commit()
        logger.info(f"Role '{req.role_name}' assigned to admin {admin_id} by {admin['user_id']}")
        return {
            "status": "success",
            "message": f"Role '{req.role_name}' assigned successfully",
            "user_role_id": row.id
        }
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        if "unique" in str(exc).lower():
            raise HTTPException(status_code=409, detail="This role is already assigned to this admin")
        raise HTTPException(status_code=500, detail=f"Failed to assign role: {exc}")


@router.delete("/{admin_id}/roles/{user_role_id}")
async def revoke_role(
    admin_id: str,
    user_role_id: str,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("admin.manage"))
):
    """
    Revokes (unbinds) a specific role assignment from an admin user.
    """
    try:
        result = await db.execute(
            text("""
                DELETE FROM public.admin_user_roles
                WHERE id = :user_role_id AND admin_user_id = :admin_id
            """),
            {"user_role_id": user_role_id, "admin_id": admin_id}
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Role assignment not found")
        await db.commit()
        logger.info(f"Role assignment {user_role_id} revoked from admin {admin_id} by {admin['user_id']}")
        return {"status": "success", "message": "Role assignment revoked"}
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to revoke role: {exc}")


# ---------------------------------------------------------------------------
# Audit Logs
# ---------------------------------------------------------------------------

@router.get("/audit-logs")
async def list_audit_logs(
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("audit.read"))
):
    """
    Retrieves global platform audit log entries, paginated and ordered newest first.
    """
    result = await db.execute(
        text("""
            SELECT
                gal.id,
                gal.tenant_id::text,
                t.slug AS tenant_slug,
                gal.event_type,
                gal.payload,
                gal.created_at::text,
                au.email AS admin_email
            FROM public.global_audit_log gal
            LEFT JOIN public.tenants t ON t.id = gal.tenant_id
            LEFT JOIN public.admin_users au ON au.id = gal.admin_user_id
            ORDER BY gal.created_at DESC
            LIMIT :limit OFFSET :offset
        """),
        {"limit": limit, "offset": offset}
    )
    rows = result.fetchall()
    return [
        {
            "id": row.id,
            "tenant_id": row.tenant_id,
            "tenant_slug": row.tenant_slug,
            "event_type": row.event_type,
            "payload": row.payload,
            "created_at": row.created_at,
            "admin_email": row.admin_email
        } for row in rows
    ]


# ---------------------------------------------------------------------------
# Client / Tenant Telemetry Observability
# ---------------------------------------------------------------------------

@router.get("/clients")
async def list_clients(
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("tenant.read"))
):
    """
    Lists all registered clients/tenants with aggregated high-level resource summaries.
    Counts are pulled directly from each client_{slug} schema using explicit schema qualification.
    """
    result = await db.execute(text("""
        SELECT id::text, slug, name, status, created_at::text
        FROM public.tenants
        ORDER BY created_at DESC
    """))
    tenants = result.fetchall()

    summaries = []
    for tenant in tenants:
        # Validate slug is safe for use in identifiers (already enforced by DB constraint)
        schema = f"client_{tenant.slug}"
        try:
            counts_res = await db.execute(text(f"""
                SELECT
                    (SELECT COUNT(*) FROM {schema}.servers)                                          AS server_count,
                    (SELECT COUNT(*) FROM {schema}.sentinel_agents WHERE status = 'active')          AS active_agent_count,
                    (SELECT COUNT(*) FROM {schema}.canary_decoy_files WHERE status = 'planted')      AS planted_decoy_count,
                    (SELECT COUNT(*) FROM {schema}.tamper_alerts)                                    AS alert_count
            """))
            counts = counts_res.fetchone()
            summaries.append({
                "id": tenant.id,
                "slug": tenant.slug,
                "name": tenant.name,
                "status": tenant.status,
                "created_at": tenant.created_at,
                "server_count": counts.server_count,
                "active_agent_count": counts.active_agent_count,
                "planted_decoy_count": counts.planted_decoy_count,
                "alert_count": counts.alert_count
            })
        except Exception:
            # Schema may not yet be fully provisioned
            summaries.append({
                "id": tenant.id,
                "slug": tenant.slug,
                "name": tenant.name,
                "status": tenant.status,
                "created_at": tenant.created_at,
                "server_count": None,
                "active_agent_count": None,
                "planted_decoy_count": None,
                "alert_count": None
            })

    return summaries


@router.get("/clients/{company_slug}")
async def get_client_detail(
    company_slug: str,
    db: AsyncSession = Depends(get_db_session),
    admin: dict = Depends(RequirePermission("tenant.read"))
):
    """
    Returns a comprehensive client-specific dashboard — servers, agents,
    decoy inventory, and a feed of recent tamper alerts.
    Uses explicit schema-qualified table names to avoid connection pool search_path issues.
    """
    # Verify tenant exists
    t_res = await db.execute(
        text("SELECT id::text, slug, name, status, created_at::text FROM public.tenants WHERE slug = :slug"),
        {"slug": company_slug}
    )
    tenant = t_res.fetchone()
    if not tenant:
        raise HTTPException(status_code=404, detail=f"Client '{company_slug}' not found")

    schema = f"client_{company_slug}"

    try:
        # Servers
        servers_res = await db.execute(text(f"""
            SELECT id::text, hostname, ip_address::text, COALESCE(specs->>'os_type', 'Linux') AS os_type, status, created_at::text
            FROM {schema}.servers ORDER BY created_at DESC
        """))
        servers = [dict(r._mapping) for r in servers_res.fetchall()]

        # Sentinel Agents
        agents_res = await db.execute(text(f"""
            SELECT id::text, server_id::text, status, version, last_connected_at::text AS last_seen_at, created_at::text
            FROM {schema}.sentinel_agents ORDER BY last_connected_at DESC NULLS LAST
        """))
        agents = [dict(r._mapping) for r in agents_res.fetchall()]

        # Decoy Files
        decoys_res = await db.execute(text(f"""
            SELECT id::text, server_id::text, file_path, decoy_type AS file_type, status, planted_at::text
            FROM {schema}.canary_decoy_files ORDER BY planted_at DESC NULLS LAST
        """))
        decoys = [dict(r._mapping) for r in decoys_res.fetchall()]

        # Recent Tamper Alerts (last 25)
        alerts_res = await db.execute(text(f"""
            SELECT id::text, server_id::text, COALESCE(details->>'file_path', '') AS file_path, event_type AS alert_type, severity,
                   detected_at::text AS triggered_at, NULL AS resolved_at
            FROM {schema}.tamper_alerts ORDER BY detected_at DESC LIMIT 25
        """))
        alerts = [dict(r._mapping) for r in alerts_res.fetchall()]

        # Nest the relationships
        for s in servers:
            s_id = s["id"]
            s["sentinel_agents"] = [a for a in agents if a["server_id"] == s_id]
            s["decoy_files"] = [d for d in decoys if d["server_id"] == s_id]
            s["recent_alerts"] = [al for al in alerts if al["server_id"] == s_id]

        return {
            "tenant": {
                "id": tenant.id,
                "slug": tenant.slug,
                "name": tenant.name,
                "status": tenant.status,
                "created_at": tenant.created_at
            },
            "servers": servers,
            "sentinel_agents": agents,
            "decoy_files": decoys,
            "recent_alerts": alerts
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch client details for '{company_slug}': {exc}")
