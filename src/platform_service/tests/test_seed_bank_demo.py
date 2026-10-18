"""Static checks on the clean bank-demo seed: no junk data, no baked-in secrets."""
import re
from pathlib import Path

SQL = (Path(__file__).resolve().parents[3] / "database" / "scripts" / "seed_bank_demo.sql").read_text()


def test_no_password_hash_or_password_is_hardcoded():
    assert not re.search(r"\$2[aby]\$\d\d\$", SQL), "bcrypt hash literal in repo"
    assert "MockPass" not in SQL
    assert ":'admin_hash'" in SQL and ":'analyst_hash'" in SQL


def test_hashes_are_required():
    assert ":{?admin_hash}" in SQL and "RAISE EXCEPTION" in SQL or "\quit" in SQL


def test_provisions_the_tenant_and_seeds_rbac_and_a_project():
    assert "provision_tenant" in SQL
    for role in ("tenant-admin", "security-analyst", "read-only"):
        assert role in SQL
    assert "INSERT INTO projects" in SQL and "INSERT INTO user_roles" in SQL


def test_seeds_no_fake_infrastructure_or_alerts():
    for table in ("servers", "sentinel_agents", "canary_decoy_files", "tamper_alerts", "alert_mitigations"):
        assert not re.search(rf"INSERT INTO\s+{table}\b", SQL), f"seeds {table}"
    assert "mock" not in SQL.lower().replace("mock_seed", "")
