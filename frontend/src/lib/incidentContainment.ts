import type { TopologyNode } from './holisticData';
import { timestampSchema } from './incidentBrief';

export function isolateIncidentNode(
  nodes: TopologyNode[], request: {nodeId: string; incidentId?: string},
  context: {canRespond: boolean; authenticated: boolean; confirmed: boolean; tenantId?: string; at: string},
): {nodes: TopologyNode[]; outcome: 'isolated' | 'already-isolated' | 'denied' | 'cancelled' | 'stale'} {
  if (!context.authenticated || !context.canRespond) return {nodes, outcome:'denied'};
  if (!context.confirmed) return {nodes, outcome:'cancelled'};
  const node=nodes.find(n=>n.id===request.nodeId);
  if (!node || node.incident?.id !== request.incidentId || node.incident?.state === 'resolved' || !timestampSchema.safeParse(context.at).success) return {nodes,outcome:'stale'};
  if (!context.tenantId || node.tenantId !== context.tenantId) return {nodes,outcome:'denied'};
  if (node.isolatedAt) return {nodes,outcome:'already-isolated'};
  return {outcome:'isolated',nodes:nodes.map(n=> n.id===node.id ? {
    ...n,status:'offline',isolatedAt:context.at,tampered:false,threats:0,
    incident:n.incident ? {...n.incident,state:'contained',observedAt:context.at,events:[...(n.incident.events??[]),{
      id:'isolate-'+n.id,timestamp:context.at,source:'analyst.mock-isolation',category:'response',event:'Analyst confirmed node isolation in the offline workspace.',
    }]} : undefined,
  } : n)};
}

/** Client-only mock session check. Live authorization must be enforced by the backend. */
export function isResponseSessionCurrent(authenticated: boolean, token: string | null, now: number): boolean {
  if (!authenticated || !token) return false;
  try {
    const payload=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    if (token.startsWith('demo.')) return true;
    return typeof payload.exp === 'number' && payload.exp * 1000 > now;
  } catch { return false; }
}
