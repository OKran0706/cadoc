import test from 'node:test';
import assert from 'node:assert/strict';
import { isolateIncidentNode } from '../src/lib/incidentContainment.ts';
import { INITIAL_TOPOLOGY_NODES } from '../src/lib/holisticData.ts';
import { hasActiveIncident } from '../src/lib/incidentExplainer.ts';
const nodes=INITIAL_TOPOLOGY_NODES;
const node=nodes.find(n=>n.incident?.alertType==='ledger_tamper');
const request={nodeId:node.id,incidentId:node.incident.id};
const context={canRespond:true,authenticated:true,confirmed:true,tenantId:node.tenantId,at:'2026-10-18T10:10:00.000Z'};
test('INV-6: confirmed authorized containment updates status/KPIs once and preserves evidence',()=>{
 const result=isolateIncidentNode(nodes,request,context);
 assert.equal(result.outcome,'isolated');
 const updated=result.nodes.find(n=>n.id===node.id);
 assert.equal(updated.status,'offline'); assert.equal(updated.threats,0); assert.ok(updated.isolatedAt);
 assert.deepEqual(updated.incident.signals,node.incident.signals);
 assert.equal(result.nodes.filter(hasActiveIncident).length,nodes.filter(hasActiveIncident).length-1);
 assert.equal(isolateIncidentNode(result.nodes,request,context).outcome,'already-isolated');
 assert.equal(node.isolatedAt,undefined);
});
for(const [label,change] of [['cancel',{confirmed:false}],['read-only',{canRespond:false}],['expired',{authenticated:false}],['tenant',{tenantId:'other'}],['invalid-time',{at:'bad'}]]) {
 test('INV-6: '+label+' cannot mutate state',()=>assert.equal(isolateIncidentNode(nodes,request,{...context,...change}).nodes,nodes));
}
test('INV-6: missing node or stale incident cannot mutate state',()=>{
 assert.equal(isolateIncidentNode(nodes,{...request,nodeId:'missing'},context).nodes,nodes);
 assert.equal(isolateIncidentNode(nodes,{...request,incidentId:'old'},context).nodes,nodes);
});
test('INV-6: heartbeat-offline is not mistaken for containment',()=>{
 const lost=nodes.find(n=>n.incident?.alertType==='heartbeat_lost');
 assert.ok(hasActiveIncident(lost));
 assert.equal(isolateIncidentNode(nodes,{nodeId:lost.id,incidentId:lost.incident.id},context).outcome,'isolated');
});
