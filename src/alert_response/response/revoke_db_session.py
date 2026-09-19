# canary-system/src/alert_response/response/revoke_db_session.py
# Derived from: alert-response/SKILL.md — Database Session Revocation
"""
Terminates the specific PostgreSQL backend that triggered the canary alert.
Does NOT revoke the role permanently — human decision required.
"""

import logging
import json
import os

import psycopg2

logger = logging.getLogger("response.revoke_db_session")

MONITOR_DB_CONN = os.environ.get(
    "CANARY_DB_CONN",
    "postgres://canary_monitor:canary_dev_password@localhost:5432/canarydb",
)


def revoke_db_session(db_host: str, backend_pid: int, alert_id: str) -> bool:
    """
    Terminate the specific database backend that triggered the alert.
    Logs the action before execution. Does not revoke role permanently.
    """
    try:
        with psycopg2.connect(MONITOR_DB_CONN) as conn:
            cur = conn.cursor()

            # Log before action
            cur.execute(
                "INSERT INTO canary_monitor.response_actions (alert_id, action_type, target, detail) "
                "VALUES (%s, %s, %s, %s)",
                (alert_id, "REVOKE_DB_SESSION", db_host, str(backend_pid)),
            )

            # Terminate the session
            cur.execute("SELECT pg_terminate_backend(%s)", (backend_pid,))
            result = cur.fetchone()[0]
            conn.commit()

        logger.info(
            "DB_SESSION_TERMINATED: backend_pid=%d host=%s success=%s alert=%s",
            backend_pid, db_host, result, alert_id,
        )
        return result

    except psycopg2.Error as e:
        logger.error("Failed to revoke DB session: %s", e)
        return False
