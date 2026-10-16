#!/usr/bin/env python3
"""
verify-platform-flows.py
========================
Live Staging Verification Script for Platform Service Flow Testing.

Run this from inside the Vagrant VM (or any host with network access to the
platform service) to verify that all core flows are working correctly against
a REAL running instance.

Usage:
    # Default target (localhost:8000, reads JWT_SECRET from PLATFORM_JWT_SECRET env var)
    python3 verify-platform-flows.py

    # Custom target
    python3 verify-platform-flows.py --base-url http://localhost:8000 --jwt-secret your-secret

    # Run with real login credentials (admin auth flow) instead of minted tokens
    python3 verify-platform-flows.py --use-login --email admin@cadoc.sh --password "SecurePass!"

Requirements:
    pip install httpx pyjwt
"""

import argparse
import asyncio
import json
import os
import sys
import time
import traceback
from typing import Optional

import httpx
import jwt


# ---------------------------------------------------------------------------
# ── Configuration ─────────────────────────────────────────────────────────
# ---------------------------------------------------------------------------

DEFAULT_BASE_URL = "http://localhost:8000"
DEFAULT_JWT_SECRET = os.environ.get("PLATFORM_JWT_SECRET", "changeme-dev-secret")
DEFAULT_JWT_ALGO = "HS256"
DEFAULT_COMPANY_SLUG_A = "client-a"
DEFAULT_COMPANY_SLUG_B = "client-b"

PASS = "✅ PASS"
FAIL = "❌ FAIL"
SKIP = "⏭  SKIP"


# ---------------------------------------------------------------------------
# ── Token minting helpers ─────────────────────────────────────────────────
# ---------------------------------------------------------------------------

def mint_jwt(
    sub: str,
    company_slug: str,
    tenant_id: Optional[str],
    secret: str,
    algo: str = DEFAULT_JWT_ALGO,
    ttl: int = 3600,
) -> str:
    payload = {
        "sub": sub,
        "company_slug": company_slug,
        "tenant_id": tenant_id,
        "iat": int(time.time()),
        "exp": int(time.time()) + ttl,
    }
    return jwt.encode(payload, secret, algorithm=algo)


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# ── Test runner ───────────────────────────────────────────────────────────
# ---------------------------------------------------------------------------

class FlowVerifier:
    def __init__(self, base_url: str, jwt_secret: str):
        self.base_url = base_url.rstrip("/")
        self.jwt_secret = jwt_secret
        self.results: list[dict] = []
        self._token_a: Optional[str] = None
        self._token_b: Optional[str] = None
        self._token_global: Optional[str] = None

    # -- Token helpers -------------------------------------------------------

    def _tok(self, slug: str, user_id: str = "admin", tenant_id: Optional[str] = None) -> str:
        return mint_jwt(
            sub=user_id,
            company_slug=slug,
            tenant_id=tenant_id or (f"{slug}-tenant-id" if slug != "global" else None),
            secret=self.jwt_secret,
        )

    @property
    def tok_a(self) -> str:
        if not self._token_a:
            self._token_a = self._tok(DEFAULT_COMPANY_SLUG_A)
        return self._token_a

    @property
    def tok_b(self) -> str:
        if not self._token_b:
            self._token_b = self._tok(DEFAULT_COMPANY_SLUG_B)
        return self._token_b

    @property
    def tok_global(self) -> str:
        if not self._token_global:
            self._token_global = self._tok("global")
        return self._token_global

    # -- Assertion helpers ---------------------------------------------------

    def _record(self, name: str, status: str, detail: str = ""):
        icon = PASS if status == "PASS" else (SKIP if status == "SKIP" else FAIL)
        line = f"  {icon}  {name}"
        if detail:
            line += f"  [{detail}]"
        print(line)
        self.results.append({"name": name, "status": status, "detail": detail})

    def _check(self, name: str, condition: bool, detail: str = ""):
        self._record(name, "PASS" if condition else "FAIL", detail)
        return condition

    # -- Individual flow verifications --------------------------------------

    async def verify_health(self, client: httpx.AsyncClient) -> bool:
        """Verify the service health endpoint is reachable."""
        print("\n[Flow 0] Health Check")
        try:
            r = await client.get(f"{self.base_url}/health")
            return self._check(
                "GET /health → 200",
                r.status_code == 200,
                f"status={r.status_code}",
            )
        except Exception as exc:
            self._record("GET /health → reachable", "FAIL", str(exc))
            return False

    async def verify_project_crud(self, client: httpx.AsyncClient) -> Optional[str]:
        """Create and list projects for tenant A. Returns created project_id or None."""
        print("\n[Flow 1] Project CRUD (Tenant A)")
        project_id = None

        # Create project
        try:
            r = await client.post(
                f"{self.base_url}/api/v1/projects/",
                json={"name": "Staging Test Project", "description": "Created by verify-platform-flows.py"},
                headers=auth_headers(self.tok_a),
            )
            ok = self._check(
                "POST /api/v1/projects/ → 200",
                r.status_code == 200,
                f"status={r.status_code} body={r.text[:120]}",
            )
            if ok:
                data = r.json()
                project_id = data.get("id")
                self._check("Response contains project id", bool(project_id), f"id={project_id}")
                self._check("Project name matches", data.get("name") == "Staging Test Project")
        except Exception as exc:
            self._record("POST /api/v1/projects/ → 200", "FAIL", str(exc))

        # List projects
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/projects/",
                headers=auth_headers(self.tok_a),
            )
            ok = self._check(
                "GET /api/v1/projects/ → 200",
                r.status_code == 200,
                f"status={r.status_code}",
            )
            if ok and project_id:
                project_ids = [p["id"] for p in r.json()]
                self._check(
                    "Newly created project appears in list",
                    project_id in project_ids,
                    f"found={project_id in project_ids}",
                )
        except Exception as exc:
            self._record("GET /api/v1/projects/ → 200", "FAIL", str(exc))

        return project_id

    async def verify_server_crud(
        self, client: httpx.AsyncClient, project_id: str
    ) -> Optional[str]:
        """Register and list servers for tenant A. Returns created server_id or None."""
        print("\n[Flow 2] Server CRUD (Tenant A)")
        server_id = None

        # Register server
        try:
            r = await client.post(
                f"{self.base_url}/api/v1/servers/",
                json={
                    "project_id": project_id,
                    "hostname": "staging-verify-node.internal",
                    "ip_address": "10.99.0.1",
                    "status": "online",
                },
                headers=auth_headers(self.tok_a),
            )
            ok = self._check(
                "POST /api/v1/servers/ → 200",
                r.status_code == 200,
                f"status={r.status_code} body={r.text[:120]}",
            )
            if ok:
                data = r.json()
                server_id = data.get("id")
                self._check("Response contains server id", bool(server_id), f"id={server_id}")
                self._check(
                    "Server hostname matches",
                    data.get("hostname") == "staging-verify-node.internal",
                )
        except Exception as exc:
            self._record("POST /api/v1/servers/ → 200", "FAIL", str(exc))

        # List servers
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/servers/",
                headers=auth_headers(self.tok_a),
            )
            ok = self._check(
                "GET /api/v1/servers/ → 200",
                r.status_code == 200,
                f"status={r.status_code}",
            )
            if ok and server_id:
                server_ids = [s["id"] for s in r.json()]
                self._check(
                    "Newly registered server appears in list",
                    server_id in server_ids,
                )
        except Exception as exc:
            self._record("GET /api/v1/servers/ → 200", "FAIL", str(exc))

        return server_id

    async def verify_bootstrap_join(
        self, client: httpx.AsyncClient, server_id: str
    ) -> Optional[str]:
        """Obtain a join token for the registered server. Returns token or None."""
        print("\n[Flow 3] Bootstrap Join Token (Tenant A)")
        join_token = None

        try:
            r = await client.post(
                f"{self.base_url}/api/v1/bootstrap/join",
                json={"server_id": server_id},
                headers=auth_headers(self.tok_a),
            )
            ok = self._check(
                "POST /api/v1/bootstrap/join → 200",
                r.status_code == 200,
                f"status={r.status_code} body={r.text[:120]}",
            )
            if ok:
                data = r.json()
                join_token = data.get("join_token")
                self._check("join_token present in response", bool(join_token))
                self._check("client_id contains company slug", DEFAULT_COMPANY_SLUG_A in data.get("client_id", ""))
        except Exception as exc:
            self._record("POST /api/v1/bootstrap/join → 200", "FAIL", str(exc))

        return join_token

    async def verify_agent_list(self, client: httpx.AsyncClient):
        """List agents for tenant A (may be empty on fresh staging)."""
        print("\n[Flow 4] Agent List (Tenant A)")
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/agents/",
                headers=auth_headers(self.tok_a),
            )
            self._check(
                "GET /api/v1/agents/ → 200",
                r.status_code == 200,
                f"status={r.status_code}",
            )
            if r.status_code == 200:
                agents = r.json()
                self._check(
                    "Agent list is a list",
                    isinstance(agents, list),
                    f"count={len(agents)}",
                )
        except Exception as exc:
            self._record("GET /api/v1/agents/ → 200", "FAIL", str(exc))

    async def verify_cross_tenant_isolation(
        self, client: httpx.AsyncClient, project_id: Optional[str], server_id: Optional[str]
    ):
        """
        Verify Tenant B CANNOT access Tenant A's resources.
        Expected: empty lists (schema isolation) or 404 (project/server not in B's schema).
        """
        print("\n[Flow 5] Cross-Tenant Isolation (Tenant B cannot see Tenant A's resources)")

        # Projects list — Tenant B's schema should be empty (or not contain A's project)
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/projects/",
                headers=auth_headers(self.tok_b),
            )
            ok = self._check(
                "GET /api/v1/projects/ as Tenant B → 200",
                r.status_code == 200,
                f"status={r.status_code}",
            )
            if ok and project_id:
                tenant_b_project_ids = [p["id"] for p in r.json()]
                self._check(
                    "Tenant A project NOT visible to Tenant B",
                    project_id not in tenant_b_project_ids,
                    f"A_project_in_B={project_id in tenant_b_project_ids}",
                )
        except Exception as exc:
            self._record("Cross-tenant project isolation", "FAIL", str(exc))

        # Servers list — Tenant B's schema should be empty
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/servers/",
                headers=auth_headers(self.tok_b),
            )
            ok = self._check(
                "GET /api/v1/servers/ as Tenant B → 200",
                r.status_code == 200,
                f"status={r.status_code}",
            )
            if ok and server_id:
                tenant_b_server_ids = [s["id"] for s in r.json()]
                self._check(
                    "Tenant A server NOT visible to Tenant B",
                    server_id not in tenant_b_server_ids,
                    f"A_server_in_B={server_id in tenant_b_server_ids}",
                )
        except Exception as exc:
            self._record("Cross-tenant server isolation", "FAIL", str(exc))

        # Agents list — Tenant B should see only their own agents (empty unless pre-provisioned)
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/agents/",
                headers=auth_headers(self.tok_b),
            )
            self._check(
                "GET /api/v1/agents/ as Tenant B → 200",
                r.status_code == 200,
                f"status={r.status_code}",
            )
        except Exception as exc:
            self._record("Cross-tenant agent isolation", "FAIL", str(exc))

        # Bootstrap join — Tenant B trying to get join token for Tenant A's server → 404
        if server_id:
            try:
                r = await client.post(
                    f"{self.base_url}/api/v1/bootstrap/join",
                    json={"server_id": server_id},
                    headers=auth_headers(self.tok_b),
                )
                self._check(
                    "POST /api/v1/bootstrap/join Tenant A server as Tenant B → 404",
                    r.status_code == 404,
                    f"status={r.status_code} (expected 404 — server absent from Tenant B schema)",
                )
            except Exception as exc:
                self._record("Cross-tenant bootstrap isolation", "FAIL", str(exc))

    async def verify_global_admin_delegation(self, client: httpx.AsyncClient):
        """
        Verify global admin can delegate to a tenant using company_slug parameter.
        """
        print("\n[Flow 6] Global Admin Delegation Flows")

        # Global admin listing without company_slug → 400
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/projects/",
                headers=auth_headers(self.tok_global),
            )
            self._check(
                "GET /api/v1/projects/ as global (no slug) → 400",
                r.status_code == 400,
                f"status={r.status_code}",
            )
        except Exception as exc:
            self._record("Global admin no-slug rejected", "FAIL", str(exc))

        # Global admin listing WITH company_slug → should succeed
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/projects/?company_slug={DEFAULT_COMPANY_SLUG_A}",
                headers=auth_headers(self.tok_global),
            )
            self._check(
                f"GET /api/v1/projects/?company_slug={DEFAULT_COMPANY_SLUG_A} as global → 200",
                r.status_code == 200,
                f"status={r.status_code}",
            )
        except Exception as exc:
            self._record("Global admin delegation (with slug)", "FAIL", str(exc))

        # Servers
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/servers/",
                headers=auth_headers(self.tok_global),
            )
            self._check(
                "GET /api/v1/servers/ as global (no slug) → 400",
                r.status_code == 400,
                f"status={r.status_code}",
            )
        except Exception as exc:
            self._record("Global admin server no-slug rejected", "FAIL", str(exc))

        # Agents — global scope always rejected
        try:
            r = await client.get(
                f"{self.base_url}/api/v1/agents/",
                headers=auth_headers(self.tok_global),
            )
            self._check(
                "GET /api/v1/agents/ as global → 400 (Scope mismatch)",
                r.status_code == 400,
                f"status={r.status_code}",
            )
        except Exception as exc:
            self._record("Global admin agent scope guard", "FAIL", str(exc))

    async def verify_error_paths(self, client: httpx.AsyncClient):
        """Spot-check error-path responses."""
        print("\n[Flow 7] Error Path Spot Checks")

        # Project: invalid SQL-injection slug should be caught at token decode
        # (only testable if we can mint an arbitrary JWT with a bad slug)
        try:
            bad_token = mint_jwt(
                sub="attacker",
                company_slug="client-a; DROP SCHEMA",
                tenant_id="t-x",
                secret=self.jwt_secret,
            )
            r = await client.post(
                f"{self.base_url}/api/v1/projects/",
                json={"name": "Injected"},
                headers=auth_headers(bad_token),
            )
            self._check(
                "Project create with injection slug → 400",
                r.status_code == 400,
                f"status={r.status_code}",
            )
        except Exception as exc:
            self._record("Injection slug guard (projects)", "FAIL", str(exc))

        # Agents: global scope → 400
        try:
            r = await client.post(
                f"{self.base_url}/api/v1/agents/nonexistent-agent/decommission",
                headers=auth_headers(self.tok_global),
            )
            self._check(
                "Decommission agent as global → 400",
                r.status_code == 400,
                f"status={r.status_code}",
            )
        except Exception as exc:
            self._record("Decommission scope guard", "FAIL", str(exc))

        # Bootstrap join with global JWT → 400
        try:
            r = await client.post(
                f"{self.base_url}/api/v1/bootstrap/join",
                json={"server_id": "any-id"},
                headers=auth_headers(self.tok_global),
            )
            self._check(
                "Bootstrap join as global → 400",
                r.status_code == 400,
                f"status={r.status_code}",
            )
        except Exception as exc:
            self._record("Bootstrap join scope guard", "FAIL", str(exc))

    # -- Main runner ---------------------------------------------------------

    async def run_all(self) -> int:
        """Execute all flows. Returns 0 on full pass, 1 on any failure."""
        print("=" * 60)
        print("  Platform Service — Live Flow Verification")
        print(f"  Target: {self.base_url}")
        print("=" * 60)

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Flow 0: Health gate — abort early if service is down
            health_ok = await self.verify_health(client)
            if not health_ok:
                print("\n⚠️  Service unreachable. Aborting all flows.")
                return 1

            # Flow 1-4: Happy path lifecycle
            project_id = await self.verify_project_crud(client)
            server_id = None
            if project_id:
                server_id = await self.verify_server_crud(client, project_id)
            else:
                self._record("Server CRUD (Tenant A)", "SKIP", "no project_id from previous flow")

            if server_id:
                await self.verify_bootstrap_join(client, server_id)
            else:
                self._record("Bootstrap Join", "SKIP", "no server_id from previous flow")

            await self.verify_agent_list(client)

            # Flow 5: Cross-tenant isolation
            await self.verify_cross_tenant_isolation(client, project_id, server_id)

            # Flow 6: Global admin delegation
            await self.verify_global_admin_delegation(client)

            # Flow 7: Error paths
            await self.verify_error_paths(client)

        # Summary
        passes = sum(1 for r in self.results if r["status"] == "PASS")
        fails  = sum(1 for r in self.results if r["status"] == "FAIL")
        skips  = sum(1 for r in self.results if r["status"] == "SKIP")
        total  = len(self.results)

        print("\n" + "=" * 60)
        print(f"  Results: {passes}/{total} passed   {fails} failed   {skips} skipped")
        print("=" * 60)

        if fails > 0:
            print(f"\n{FAIL}  {fails} check(s) failed — review output above.\n")
            return 1
        else:
            print(f"\n🏆  ALL CHECKS PASSED — Platform Service flows verified.\n")
            return 0


# ---------------------------------------------------------------------------
# ── CLI entrypoint ────────────────────────────────────────────────────────
# ---------------------------------------------------------------------------

async def main_async() -> int:
    parser = argparse.ArgumentParser(
        description="Live platform-service flow verification script"
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Base URL of the platform service (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--jwt-secret",
        default=DEFAULT_JWT_SECRET,
        help="JWT secret used by the running platform service",
    )
    args = parser.parse_args()

    verifier = FlowVerifier(base_url=args.base_url, jwt_secret=args.jwt_secret)
    return await verifier.run_all()


if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main_async())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\nAborted by user.")
        sys.exit(2)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
