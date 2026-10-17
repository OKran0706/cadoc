"""Static checks: quarantine columns exist for new tenants (001) and existing ones (004)."""
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[3] / "database" / "migrations"
COLUMNS = ("status", "target_pid", "target_exe", "target_comm", "result_msg")


def _alert_mitigations_ddl(sql: str) -> str:
    start = sql.index("CREATE TABLE %I.alert_mitigations")
    return sql[start : sql.index("$ddl$", start)]


def test_new_tenants_get_quarantine_columns():
    ddl = _alert_mitigations_ddl((MIGRATIONS / "001_multi_tenant_onboarding.sql").read_text())
    for col in COLUMNS:
        assert col in ddl


def test_existing_tenants_migrated_idempotently():
    sql = (MIGRATIONS / "004_alert_mitigation_quarantine.sql").read_text()
    assert "client\_%" in sql
    for col in COLUMNS:
        assert f"ADD COLUMN IF NOT EXISTS {col}" in sql


def test_status_has_no_default():
    # Legacy notes-only mitigations must not read as quarantined.
    sql = (MIGRATIONS / "004_alert_mitigation_quarantine.sql").read_text()
    assert "ADD COLUMN IF NOT EXISTS status TEXT," in sql or "ADD COLUMN IF NOT EXISTS status TEXT\n" in sql
    assert "DEFAULT" not in sql.split("status", 1)[1].split("\n", 1)[0]
