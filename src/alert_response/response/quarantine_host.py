# canary-system/src/alert_response/response/quarantine_host.py
# Derived from: alert-response/SKILL.md — Host Network Quarantine
"""
Host network quarantine via iptables — drops all traffic except
security team SSH and canary telemetry.
Implemented as a Python wrapper around the shell commands.
"""

import logging
import os
import subprocess

logger = logging.getLogger("response.quarantine_host")

SECURITY_TEAM_IP = os.environ.get("CANARY_SECURITY_TEAM_IP", "10.0.1.0/24")


def quarantine_host(alert_id: str):
    """
    Apply iptables rules to isolate a host.
    Allows SSH from security team IP and canary telemetry only.
    All actions are logged before execution.
    """
    logger.warning("QUARANTINE_HOST: alert_id=%s — applying iptables rules", alert_id)

    # Log the action via syslog
    _syslog(f"canary-response QUARANTINE_HOST alert_id={alert_id}")

    # Get canary telemetry endpoint
    canary_endpoint = os.environ.get("CANARY_REMOTE_LOG_ENDPOINT", "")

    rules = [
        # Allow security team SSH inbound
        ["iptables", "-I", "INPUT", "1", "-s", SECURITY_TEAM_IP, "-p", "tcp", "--dport", "22", "-j", "ACCEPT"],
        # Drop all other inbound
        ["iptables", "-I", "INPUT", "2", "-j", "DROP"],
        # Allow canary telemetry outbound
    ]

    if canary_endpoint:
        rules.append(["iptables", "-I", "OUTPUT", "1", "-d", canary_endpoint, "-j", "ACCEPT"])

    rules.extend([
        # Allow security team outbound
        ["iptables", "-I", "OUTPUT", "2" if canary_endpoint else "1",
         "-d", SECURITY_TEAM_IP, "-j", "ACCEPT"],
        # Drop all other outbound
        ["iptables", "-I", "OUTPUT", "3" if canary_endpoint else "2", "-j", "DROP"],
    ])

    for rule in rules:
        try:
            subprocess.run(rule, check=True, capture_output=True)
            logger.info("Applied: %s", " ".join(rule))
        except subprocess.CalledProcessError as e:
            logger.error("iptables rule failed: %s — stderr: %s", " ".join(rule), e.stderr)

    # Save rules for persistence
    try:
        subprocess.run(
            ["bash", "-c", "iptables-save > /etc/iptables/rules.v4"],
            check=True, capture_output=True,
        )
    except subprocess.CalledProcessError:
        logger.warning("Failed to persist iptables rules")

    logger.warning(
        "Host quarantined. Access restricted to security team (%s). Alert: %s",
        SECURITY_TEAM_IP, alert_id,
    )


def _syslog(message: str):
    """Log to syslog via logger command."""
    try:
        subprocess.run(["logger", "-t", "canary-response", message], check=False)
    except FileNotFoundError:
        pass
