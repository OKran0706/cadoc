# canary-system/src/detection_engine/enrichment.py
# Derived from: detection-engine/SKILL.md — Enrichment
"""
Alert enrichment — adds Kubernetes context, process lineage, and
LDAP/SSO user identity before forwarding to the alert pipeline.
"""

import logging
import os

logger = logging.getLogger("detection.enrichment")


def enrich_alert(alert: dict, k8s_client=None, process_registry=None) -> dict:
    """
    Enrich an alert with contextual information:
    - Process lineage (parent PID chain)
    - Kubernetes pod/namespace/labels
    - LDAP user identity for human users
    """

    # Add process lineage
    if "pid" in alert and alert.get("host"):
        alert["process_lineage"] = _get_process_lineage(alert.get("pid"))

    # Add Kubernetes context
    if alert.get("container_id") and k8s_client:
        try:
            pod = _get_pod_by_container(k8s_client, alert["container_id"])
            if pod:
                alert["k8s"] = {
                    "pod": pod.metadata.name,
                    "namespace": pod.metadata.namespace,
                    "labels": dict(pod.metadata.labels or {}),
                    "node": pod.spec.node_name,
                    "service_account": pod.spec.service_account_name,
                }
        except Exception as e:
            logger.warning("K8s enrichment failed: %s", e)

    # Add user identity enrichment
    unix_user = alert.get("unix_user") or alert.get("user")
    if unix_user and not str(unix_user).startswith("svc-"):
        user_info = _ldap_lookup(unix_user)
        if user_info:
            alert["user_info"] = user_info

    return alert


def _get_process_lineage(pid: int) -> list:
    """
    Get process lineage by walking /proc/{pid}/stat parent PIDs.
    Returns list of "process_name(pid)" strings.
    """
    lineage = []
    current_pid = pid
    visited = set()

    while current_pid > 1 and current_pid not in visited:
        visited.add(current_pid)
        try:
            with open(f"/proc/{current_pid}/comm") as f:
                comm = f.read().strip()
            with open(f"/proc/{current_pid}/stat") as f:
                stat_line = f.read()
                # PPID is the 4th field in /proc/pid/stat
                parts = stat_line.split(")")[-1].split()
                ppid = int(parts[1])  # 3rd field after closing paren
            lineage.append(f"{comm}({current_pid})")
            current_pid = ppid
        except (OSError, ValueError, IndexError):
            break

    return lineage


def _get_pod_by_container(k8s_client, container_id: str):
    """Find the Kubernetes pod containing a specific container ID."""
    from kubernetes import client as k8s

    v1 = k8s.CoreV1Api(k8s_client)

    # Search all pods for the container ID
    pods = v1.list_pod_for_all_namespaces(limit=500)
    for pod in pods.items:
        if pod.status and pod.status.container_statuses:
            for cs in pod.status.container_statuses:
                if cs.container_id and container_id in cs.container_id:
                    return pod
    return None


def _ldap_lookup(username: str) -> dict:
    """
    Look up user identity via LDAP/SSO.
    Returns dict with display_name, email, department, etc.
    Fails gracefully if LDAP is not configured.
    """
    ldap_url = os.environ.get("CANARY_LDAP_URL")
    if not ldap_url:
        return {}

    try:
        # Simplified LDAP lookup via HTTP API (assumes LDAP proxy)
        import requests
        resp = requests.get(
            f"{ldap_url}/api/users/{username}",
            timeout=5,
        )
        if resp.status_code == 200:
            data = resp.json()
            return {
                "display_name": data.get("displayName", username),
                "email": data.get("email", ""),
                "department": data.get("department", ""),
                "manager": data.get("manager", ""),
            }
    except Exception as e:
        logger.debug("LDAP lookup failed for %s: %s", username, e)

    return {}
