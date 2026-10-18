import test from 'node:test';
import assert from 'node:assert/strict';
import { explainIncident } from '../src/lib/incidentExplainer.ts';
import { incidentBriefSchema, formatBriefAsMarkdown } from '../src/lib/incidentBrief.ts';
import { INITIAL_TOPOLOGY_NODES } from '../src/lib/holisticData.ts';

const nodes = INITIAL_TOPOLOGY_NODES;
const get = (type) => structuredClone(nodes.find(n => n.incident?.alertType === type));
const explain = (node, incident = node.incident) => explainIncident(node, incident, { allNodes: nodes });
const expected = {ledger_tamper:'T1565.001',canary_access:'T1552.001',credential_read:'T1003.008',agent_disabled:'T1685',heartbeat_lost:null,memory_injection:'T1055'};
for (const [type, technique] of Object.entries(expected)) {
  test(`INV-1/2/3: ${type} produces a grounded, deterministic, validated brief`, () => {
    const node = get(type);
    assert.ok(node, `Missing seeded ${type} incident`);
    const original = structuredClone(node);
    const brief = explain(node);
    assert.ok(brief);
    assert.ok(incidentBriefSchema.safeParse(brief).success);
    assert.deepEqual(brief, explain(node));
    assert.deepEqual(node, original);
    assert.equal(brief.engine, 'rules');
    assert.equal(brief.detectedAt, node.incident.detectedAt);
    for (const value of [node.geo.city,node.facility.name,node.placement.rack,'UTC',node.geo.timezone]) assert.ok(brief.summary.includes(value));
    assert.equal(brief.evidence.length, node.incident.signals.length);
    for (const item of brief.evidence) {
      const signal = node.incident.signals.find(s => s.id === item.id);
      assert.ok(signal);
      assert.equal(item.timestamp, signal.timestamp);
      assert.equal(item.sourceField, signal.sourceField);
    }
    assert.ok(brief.timeline.length >= 4 && brief.timeline.length <= 8);
    for (const event of brief.timeline) assert.ok(node.incident.events.some(e => e.id === event.id && e.event === event.event && e.timestamp === event.timestamp));
    assert.ok(brief.timeline.some(e => e.timestamp < brief.detectedAt));
    assert.ok(brief.timeline.some(e => e.timestamp > brief.detectedAt));
    assert.deepEqual(brief.timeline.map(e=>e.timestamp), brief.timeline.map(e=>e.timestamp).sort());
    assert.equal(brief.attackMapping[0]?.techniqueId ?? null, technique);
    if (!technique) assert.match(brief.unmappedReason, /heartbeat|service stop/i);
    assert.ok(brief.recommendedActions.length >= 3);
    assert.ok(!JSON.stringify(brief).includes('undefined'));
  });
}
test('INV-1/3: signal values drive facts; unrelated and duplicate sensors do not inflate confidence', () => {
  const node = get('ledger_tamper');
  assert.ok(node);
  node.incident.signals[0].actualHash = 'bbbbcccc';
  const one = node.incident.signals[0];
  node.incident.signals = [one];
  let brief = explain(node);
  assert.match(brief.evidence[0].description, /bbbbcccc/);
  assert.equal(brief.attackMapping[0].confidence, 'Low');
  node.incident.signals.push({...one,id:'duplicate'},get('heartbeat_lost').incident.signals[0]);
  assert.equal(explain(node).attackMapping[0].confidence, 'Low');
  node.incident.signals = get('ledger_tamper').incident.signals.slice(0,2);
  assert.equal(explain(node).attackMapping[0].confidence, 'Medium');
  node.incident.signals = get('ledger_tamper').incident.signals;
  assert.equal(explain(node).attackMapping[0].confidence, 'High');
});
test('INV-3: a canary touch without credential-file evidence is unmapped', () => {
  const node=get('canary_access');
  node.incident.signals=node.incident.signals.filter(s=>s.kind==='canary_access');
  assert.deepEqual(explain(node).attackMapping,[]);
});
test('INV-1/4: incomplete and malformed telemetry never becomes invented evidence or time', () => {
  const node=get('ledger_tamper');
  delete node.geo; delete node.facility; delete node.placement;
  node.incident.signals=[{kind:'hash_mismatch',timestamp:'yesterday'}, {...get('ledger_tamper').incident.signals[0],path:'x'.repeat(5000)}];
  node.incident.events=[]; node.incident.detectedAt='2m ago'; delete node.incident.observedAt;
  const brief=explain(node);
  assert.ok(brief);
  assert.deepEqual(brief.evidence,[]); assert.deepEqual(brief.timeline,[]); assert.deepEqual(brief.attackMapping,[]);
  assert.equal(brief.detectedAt,undefined);
  const md=formatBriefAsMarkdown(brief);
  assert.ok(!md.includes('undefined')); assert.ok(!md.includes('## 2.')); assert.ok(!md.includes('## 7.'));
});
test('INV-2: detection date and site-local date stay correct across midnight; invalid timezone falls back to UTC', () => {
  const node=get('ledger_tamper'); node.geo.timezone='Asia/Tokyo'; node.incident.detectedAt='2026-10-18T23:50:00.000Z';
  assert.match(explain(node).summary,/19 Oct 2026, 08:50:00/);
  assert.match(explain(node).summary,/2026-10-18 23:50:00 UTC/);
  node.geo.timezone='Invalid/Zone'; assert.ok(explain(node));
});
test('INV-5: actual peer relationships, no region-as-VPC, no cross-tenant peers or silent six-node cap', () => {
  const node=get('ledger_tamper');
  const peers=Array.from({length:9},(_,i)=>({...node,id:`peer-${i}`,name:`peer-${i}`,status:'healthy'}));
  const foreign={...node,id:'foreign',tenantId:'other'};
  const regionOnly={...node,id:'region-only',cluster:'different',vpcId:'different',facility:{id:'different'},geo:{countryCode:'XX'}};
  const brief=explainIncident(node,node.incident,{allNodes:[node,...peers,foreign,regionOnly]});
  assert.equal(brief.blastRadius.neighbours.length,9);
  assert.ok(brief.blastRadius.neighbours.every(p=>p.status==='healthy'));
  assert.deepEqual(brief.blastRadius.neighbours[0].relationships,['Cluster','VPC','Facility','Country']);
});
test('INV-4/5/7: mismatch fails closed; resolved/healthy nodes have no brief; schema rejects invalid output', () => {
  const node=get('ledger_tamper');
  assert.equal(explain(node,{...node.incident,nodeId:'other'}),null);
  assert.equal(explain({...node,incident:{...node.incident,state:'resolved'}}),null);
  assert.equal(explain(nodes.find(n=>n.status==='healthy' && !n.incident)),null);
  assert.equal(incidentBriefSchema.safeParse({...explain(node),summary:'x'.repeat(9000)}).success,false);
  const badLink=structuredClone(explain(node)); badLink.attackMapping[0].url='javascript:alert(1)';
  assert.equal(incidentBriefSchema.safeParse(badLink).success,false);
});
test('INV-9: Markdown includes facts, inference, relationships and current checklist state', () => {
  const brief=explain(get('ledger_tamper'));
  const action=brief.recommendedActions.find(a=>!a.isAppAction);
  const md=formatBriefAsMarkdown(brief,{[action.id]:true});
  for(let i=1;i<=7;i++) assert.match(md,new RegExp(`## ${i}\\.`));
  assert.match(md,/Analysis \(inference\)/); assert.match(md,/\[x\]/); assert.match(md,/Rules engine/);
  assert.ok(md.includes(brief.evidence[0].sourceField)); assert.ok(md.includes(brief.evidence[0].timestamp));
});
