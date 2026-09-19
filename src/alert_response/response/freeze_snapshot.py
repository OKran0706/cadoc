# canary-system/src/alert_response/response/freeze_snapshot.py
# Derived from: alert-response/SKILL.md — PVC Snapshot Freeze
"""
Adds a finalizer to VolumeSnapshot to prevent deletion and 
annotates it for forensic review. No deletion — only preservation.
"""

import logging
import json
from datetime import datetime, timezone

logger = logging.getLogger("response.freeze_snapshot")


def freeze_unauthorized_snapshot(namespace: str, snapshot_name: str, alert_id: str):
    """
    Freeze a VolumeSnapshot by adding a finalizer and quarantine annotations.
    Prevents deletion until manually removed by security team.
    """
    from kubernetes import client as k8s, config as k8s_config

    try:
        k8s_config.load_incluster_config()
    except k8s_config.ConfigException:
        k8s_config.load_kube_config()

    snap_api = k8s.CustomObjectsApi()

    patch = {
        "metadata": {
            "finalizers": ["canary-system/forensic-hold"],
            "annotations": {
                "canary-system/alert-id": alert_id,
                "canary-system/status": "quarantined",
                "canary-system/quarantine-time": datetime.now(timezone.utc).isoformat(),
            },
        }
    }

    try:
        snap_api.patch_namespaced_custom_object(
            group="snapshot.storage.k8s.io",
            version="v1",
            namespace=namespace,
            plural="volumesnapshots",
            name=snapshot_name,
            body=patch,
        )
        logger.info(
            "SNAPSHOT_FROZEN: snapshot=%s namespace=%s alert=%s",
            snapshot_name, namespace, alert_id,
        )
        _log_response_action("SNAPSHOT_FROZEN", alert_id, {
            "snapshot": snapshot_name,
            "namespace": namespace,
        })
    except k8s.exceptions.ApiException as e:
        logger.error("Failed to freeze snapshot %s: %s", snapshot_name, e)
        raise


def _log_response_action(action: str, alert_id: str, details: dict):
    logger.info("RESPONSE_ACTION: action=%s alert=%s details=%s", action, alert_id, json.dumps(details))
