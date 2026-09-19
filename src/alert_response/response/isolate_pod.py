# canary-system/src/alert_response/response/isolate_pod.py
# Derived from: alert-response/SKILL.md — Pod Isolation
"""
Kubernetes pod isolation via NetworkPolicy quarantine.
Does NOT delete the pod — preserves forensic evidence.
"""

import logging
import json

logger = logging.getLogger("response.isolate_pod")


def isolate_pod(namespace: str, pod_name: str, alert_id: str):
    """
    Apply a restrictive NetworkPolicy to quarantine the pod.
    Allows only DNS (port 53) egress for debugging.
    """
    from kubernetes import client as k8s, config as k8s_config

    try:
        k8s_config.load_incluster_config()
    except k8s_config.ConfigException:
        k8s_config.load_kube_config()

    networking = k8s.NetworkingV1Api()
    core = k8s.CoreV1Api()

    # Get the pod's app label
    app_label = _get_pod_app_label(core, namespace, pod_name)

    policy = k8s.V1NetworkPolicy(
        metadata=k8s.V1ObjectMeta(
            name=f"canary-quarantine-{pod_name}",
            namespace=namespace,
            annotations={
                "canary-system/alert-id": alert_id,
                "canary-system/auto-response": "true",
            },
        ),
        spec=k8s.V1NetworkPolicySpec(
            pod_selector=k8s.V1LabelSelector(
                match_labels={"app": app_label} if app_label else {}
            ),
            policy_types=["Ingress", "Egress"],
            ingress=[],  # Deny all ingress
            egress=[
                k8s.V1NetworkPolicyEgressRule(
                    ports=[k8s.V1NetworkPolicyPort(port=53, protocol="UDP")]
                )
            ],
        ),
    )

    try:
        networking.create_namespaced_network_policy(namespace, policy)
        logger.info("POD_ISOLATED: pod=%s namespace=%s alert=%s", pod_name, namespace, alert_id)
        _log_response_action("POD_ISOLATED", alert_id, {"pod": pod_name, "namespace": namespace})
    except k8s.exceptions.ApiException as e:
        if e.status == 409:
            logger.warning("Quarantine policy already exists for %s", pod_name)
        else:
            raise


def _get_pod_app_label(core_api, namespace: str, pod_name: str) -> str:
    """Get the 'app' label from a pod."""
    try:
        pod = core_api.read_namespaced_pod(pod_name, namespace)
        return (pod.metadata.labels or {}).get("app", "")
    except Exception:
        return ""


def _log_response_action(action: str, alert_id: str, details: dict):
    """Log the response action for audit trail."""
    logger.info("RESPONSE_ACTION: action=%s alert=%s details=%s", action, alert_id, json.dumps(details))
