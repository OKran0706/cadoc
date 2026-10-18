import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const artifactDir=path.resolve('docs/verification');
test.beforeAll(()=>fs.mkdirSync(artifactDir,{recursive:true}));
test.beforeEach(async({context,page})=>{
  await context.addCookies([{name:'sentinel_token',value:'offline-test',url:'http://127.0.0.1:3000'}]);
  await page.addInitScript(()=>{
    const user={email:'analyst@example.test',role:'security-analyst',name:'Test Analyst',companySlug:'sentinel-lab',permissions:['security.respond']};
    localStorage.setItem('sentinel_authenticated','true'); localStorage.setItem('sentinel_user',JSON.stringify(user));
    localStorage.setItem('auth_token','demo.'+btoa(JSON.stringify(user))+'.sig');
  });
});
test('brief: all sections, real clipboard, printable output, keyboard and peer selection',async({page})=>{
  const external:string[]=[];
  const api:string[]=[];
  await page.route('**/*',route=>{
    const url=route.request().url();
    if(url.startsWith('http') && !url.startsWith('http://127.0.0.1:3000')) {external.push(url);return route.abort();}
    if(new URL(url).pathname.startsWith('/api/')) {api.push(url);return route.abort();}
    return route.continue();
  });
  await page.goto('/holistic?view=world');
  await expect(page.getByTestId('incidents-kpi')).toHaveText('6 Incidents');
  await page.getByRole('button',{name:'Inspect ledger-validator-02',exact:true}).click();
  await page.getByRole('button',{name:'Explain this incident',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'AI Incident Brief'});
  await expect(panel.locator('section')).toHaveCount(7);
  await expect(panel).toContainText('9a1e32bd7810fa42');
  await expect(panel).toContainText('T1565.001');
  await expect(panel).toContainText('Confidence: High');
  await expect(panel).not.toContainText('undefined');
  await page.screenshot({path:path.join(artifactDir,'incident-ledger-desktop.png')});
  await panel.getByRole('checkbox').first().check();
  await panel.getByRole('button',{name:'Copy incident brief as Markdown'}).click();
  await expect(panel.getByRole('status')).toContainText('Copied as Markdown');
  const markdown=await page.evaluate(()=>navigator.clipboard.readText());
  expect(markdown).toContain('## 7. Timeline'); expect(markdown).toContain('[x]'); expect(markdown).not.toContain('undefined');
  await panel.locator('#brief-timeline').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(artifactDir,'incident-ledger-actions-timeline.png')});
  await page.evaluate(()=>{window.print=()=>document.body.setAttribute('data-print-requested','true');});
  await panel.getByRole('button',{name:'Print or save incident brief as PDF'}).click();
  await expect(page.locator('body')).toHaveAttribute('data-print-requested','true');
  await page.emulateMedia({media:'print'});
  await expect(page.getByRole('heading',{name:'Holistic Organization View'})).not.toBeVisible();
  await page.pdf({path:path.join(artifactDir,'incident-brief-print.pdf'),format:'A4',printBackground:true});
  await page.emulateMedia({media:'screen'});
  await panel.getByRole('button',{name:'Close incident brief'}).focus();
  await page.keyboard.press('Shift+Tab');
  expect(await panel.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(page.getByRole('button',{name:'Explain this incident',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Explain this incident',exact:true}).click();
  await expect(page.getByRole('status',{name:'Preparing incident brief'})).toHaveCount(0);
  await expect(panel.getByRole('checkbox').first()).toBeChecked();
  await panel.getByRole('button',{name:'Inspect eu-fintech-gateway',exact:true}).click();
  await expect(panel).toContainText('No active incident');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('forensics-hud')).toHaveAttribute('data-node-id','srv-eu-fintech-gw');
  await expect(page.getByRole('button',{name:'Explain this incident',exact:true})).toHaveCount(0);
  await expect(page.locator('.maplibregl-marker[data-selected="true"]')).toHaveCount(1);
  await page.screenshot({path:path.join(artifactDir,'blast-radius-peer-selected.png')});
  expect(external).toEqual([]); expect(api).toEqual([]);
});
test('canary and heartbeat are distinct; panel follows peer and fits mobile',async({page})=>{
  await page.goto('/holistic?view=world');
  await page.getByRole('button',{name:'Open AI brief for decoy-customer-secrets-pg'}).click();
  const panel=page.getByRole('dialog',{name:'AI Incident Brief'});
  await expect(panel).toContainText('T1552.001'); await expect(panel).toContainText('pg_admin_legacy');
  await page.screenshot({path:path.join(artifactDir,'incident-canary.png')});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Open AI brief for edge-waf-proxy-01'}).click();
  await expect(panel).toContainText('Heartbeat gap of 90 seconds'); await expect(panel).toContainText('Unmapped'); await expect(panel).not.toContainText('T1489');
  await page.screenshot({path:path.join(artifactDir,'incident-heartbeat.png')});
  await panel.getByRole('button',{name:'Inspect edge-redis-cache-cluster',exact:true}).click();
  await expect(panel).toContainText('T1055');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(artifactDir,'incident-mobile.png')});
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
});
test('isolation shares confirmation, cancellation is inert, confirmed state updates KPIs',async({page})=>{
  await page.goto('/holistic?view=world');
  await page.getByRole('button',{name:'Open AI brief for ledger-validator-02'}).click();
  const panel=page.getByRole('dialog',{name:'AI Incident Brief'});
  const isolate=panel.getByRole('button',{name:'Isolate node from brief'});
  page.once('dialog',dialog=>dialog.dismiss()); await isolate.click();
  await expect(page.getByTestId('incidents-kpi')).toHaveText('6 Incidents');
  page.once('dialog',dialog=>dialog.accept()); await isolate.click();
  await expect(panel.getByRole('button',{name:'Node isolated'})).toBeDisabled();
  await expect(page.getByTestId('incidents-kpi')).toHaveText('5 Incidents');
  await expect(page.getByTestId('monitored-kpi')).toHaveText('8 Nodes');
  await page.keyboard.press('Escape');
  await page.screenshot({path:path.join(artifactDir,'isolation-kpis.png')});
  await expect(page.getByRole('button',{name:'Explain this incident',exact:true})).toHaveCount(0);
});
test('read-only and expired session cannot isolate',async({page})=>{
  await page.goto('/holistic?view=world');
  await page.evaluate(()=>{localStorage.setItem('sentinel_user',JSON.stringify({role:'read-only',permissions:[]}));});
  // Existing hook is hydrated again with the changed role on route reload; do not re-run the init fixture.
  await page.getByRole('button',{name:'Open AI brief for ledger-validator-02'}).click();
  const panel=page.getByRole('dialog',{name:'AI Incident Brief'});
  let confirmations=0; page.on('dialog',d=>{confirmations++;void d.dismiss();});
  await panel.getByRole('button',{name:'Isolate node from brief'}).click();
  expect(confirmations).toBe(0); await expect(page.getByTestId('incidents-kpi')).toHaveText('6 Incidents');
  await page.evaluate(()=>{
    localStorage.setItem('sentinel_user',JSON.stringify({role:'security-analyst',permissions:['security.respond']}));
    localStorage.setItem('auth_token','expired.'+btoa(JSON.stringify({exp:1}))+'.sig');
  });
  await panel.getByRole('button',{name:'Isolate node from brief'}).click();
  expect(confirmations).toBe(0); await expect(page.getByTestId('incidents-kpi')).toHaveText('6 Incidents');
});
test('Aegis works across pages with local page help, keyboard search and no AI branding',async({page})=>{
  await page.route('**/api/**',route=>route.fulfill({status:200,body:'[]',contentType:'application/json'}));
  await page.goto('/holistic');
  await expect(page.getByRole('button',{name:'Open Aegis workspace helper'})).toHaveCount(1);
  await page.keyboard.press('Control+k');
  const helper=page.getByRole('dialog',{name:'Aegis'});
  await expect(helper).toContainText('ON THIS PAGE'); await expect(helper).toContainText('Holistic View');
  await expect(helper).not.toContainText('AI Guardian');
  await page.screenshot({path:path.join(artifactDir,'aegis-helper-desktop.png')});
  await helper.getByRole('textbox',{name:'Search pages and help'}).fill('settings'); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('button',{name:'Open Aegis workspace helper'}).click(); await expect(helper).toContainText('Workspace configuration');
  await page.keyboard.press('Escape'); await expect(page.getByRole('button',{name:'Open Aegis workspace helper'})).toBeFocused();
  await page.goto('/login'); await page.getByRole('button',{name:'Open Aegis workspace helper'}).click();
  await expect(helper).toContainText('Sign in'); await expect(helper.locator('.aegis-result')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844}); await page.screenshot({path:path.join(artifactDir,'aegis-helper-mobile.png')});
});
