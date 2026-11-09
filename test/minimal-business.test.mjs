import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,realpath,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capabilityInventory,compilePlan} from '../capabilities.mjs';
import {searchRecords,discoveryResult} from '../discovery.mjs';
import {classifyIntent,composePlan} from '../recipes.mjs';
import {LocalCRM} from '../crm.mjs';
import {googleRead,googleDraft,googleStatus} from '../google-workspace.mjs';
import {serviceCommand,ServiceConnections,serviceToolAllowed,validateStripeWrite} from '../services.mjs';
import {prepare} from '../scripts/connect.mjs';
import {selectVisionRoute,verifyVisualReview} from '../visual-review.mjs';
import {hash} from '../core.mjs';
import {workspaceDigest} from '../workspace.mjs';
const temp=async()=>realpath(await mkdtemp(join(tmpdir(),'boardroom-minimal-')));

test('natural-language discovery cannot misrepresent a filtered result as the installed catalog',()=>{
 const all=capabilityInventory();
 for(const query of ['list','list loaded skills and tools','show all installed workers'])assert.equal(searchRecords(all,query).length,all.length);
 const hits=searchRecords(all,'Which specialists can help with our LLC operating agreement and sales tax registration?');
 assert.ok(hits.some(x=>x.id==='corporate-legal'));assert.ok(hits.some(x=>x.id==='tax-preparation'));
 const empty=discoveryResult(all,searchRecords(all,'xyzmissing'),'xyzmissing');assert.equal(empty.totalAvailable,all.length);assert.equal(empty.matchedCount,0);assert.match(empty.guidance,/does not mean nothing/);
 assert.equal(searchRecords([{id:'site',description:'Design pages',tools:['workspace_list']}],'list').length,1);
});
test('LLC and sales-tax requests compose distinct specialist and independent review work',()=>{
 for(const [message,id] of [['Draft an operating agreement for our LLC','corporate-legal'],['Help with sales tax registration','tax-preparation']]){
  const intent=classifyIntent(message);assert.equal(intent.action,'plan');assert.ok(!intent.domains.includes('sales'));
  const plan=compilePlan(composePlan({objective:message,domains:intent.domains}));assert.ok(plan.tasks.some(t=>t.capabilityId===id));assert.equal(plan.tasks.at(-1).kind,'review');
 }
 const plan=composePlan({objective:'Review our strategy',domains:['strategy']});plan.tasks[0].capabilityId='specialist-analysis';plan.tasks[0].skills=['pm-market-sizing'];
 assert.deepEqual(compilePlan(plan).tasks[0].skills,['pm-market-sizing']);
 plan.tasks[0].skills=['../../secret'];assert.throws(()=>compilePlan(plan),/exact installed skill/);
});
test('local CRM persists records, enforces optimistic updates and isolates projects',async()=>{
 const project=await temp(),crm=new LocalCRM(project);
 const contact=await crm.save({kind:'contacts',record:{name:'Example Contact',email:'Test@Example.com',source:'Synthetic test'}});
 assert.equal((await new LocalCRM(project).list()).records[0].email,'test@example.com');
 assert.equal((await new LocalCRM(await temp()).list()).total,0);
 const deal=await crm.save({kind:'deals',record:{name:'Pilot',stage:'qualified',contactId:contact.id,amountCents:25000,currency:'USD'}});
 await crm.save({kind:'notes',record:{dealId:deal.id,text:'Customer requested a draft',source:'Synthetic test'}});
 await assert.rejects(crm.save({kind:'contacts',id:contact.id,expectedRevision:0,record:{name:'Stale'}}),/changed/);
 await assert.rejects(crm.save({kind:'contacts',record:{name:'Duplicate',email:'test@example.com'}}),/already exists/);
 await assert.rejects(crm.save({kind:'deals',record:{name:'Bad',stage:'new',nextDate:'2026-02-30'}}),/valid YYYY/);
 await assert.rejects(crm.save({kind:'notes',record:{text:'orphan',contactId:'missing'}}),/does not exist/);
 assert.equal((await stat(join(crm.root,'crm.sqlite'))).mode&0o777,0o600);
 const updated=await crm.save({kind:'contacts',id:contact.id,expectedRevision:1,record:{name:'=SUM(A1:A2)'}});assert.equal(updated.revision,2);
 const exports=await crm.export();assert.equal(exports.files.length,3);assert.match(await readFile(exports.files[0],'utf8'),/"'=SUM/);
});
test('Google operations use fixed commands, protect headers, and never send a draft',async()=>{
 const calls=[],runner=async(cmd,args,opts)=>{calls.push({cmd,args,opts});return {stdout:JSON.stringify({id:'draft-1',message:{id:'msg-1'}})};};
 await googleRead({action:'files_list',params:{q:"name contains 'Example'"}},{runner});assert.ok(calls[0].args.includes('list'));assert.ok(!calls[0].opts.shell);
 await assert.rejects(googleRead({action:'shell',params:{}},{runner}),/Unknown/);
 await assert.rejects(googleRead({action:'files_list',params:{pageSize:10000}},{runner}),/1–100/);
 await assert.rejects(googleDraft({to:'a@example.com\r\nBcc:evil@example.com',subject:'x',body:'x'},{runner}),/valid recipient/);
 const out=await googleDraft({to:'a@example.com',subject:'A draft',body:'Review this first'},{runner});assert.equal(out.sent,false);
 assert.deepEqual(calls[1].args.slice(1,5),['gmail','users','drafts','create']);assert.ok(!calls.flatMap(x=>x.args).includes('send'));
 const status=await googleStatus({runner:async()=>({stdout:JSON.stringify({client_config_exists:true,auth_method:'none'})})});assert.equal(status.credentialPresent,false);
 await assert.rejects(googleRead({action:'files_list'},{runner:async()=>{throw new Error('secret-token-123');}}),e=>!e.message.includes('secret-token'));
});
test('connection preparation is private, repeatable, and does not imply account access',async()=>{
 const previous=process.env.BOARDROOM_CONNECTIONS_HOME;process.env.BOARDROOM_CONNECTIONS_HOME=await temp();
 try{
  const q=await prepare('quickbooks');await prepare('xero');await prepare('stripe');await prepare('google');
  await writeFile(q.file,(await readFile(q.file,'utf8')).replace('QUICKBOOKS_CLIENT_ID=','QUICKBOOKS_CLIENT_ID=fixture'));
  await prepare('quickbooks');assert.match(await readFile(q.file,'utf8'),/CLIENT_ID=fixture/);assert.equal((await stat(q.file)).mode&0o777,0o600);
  await assert.rejects(serviceCommand('stripe'),/not enabled/);
  await assert.rejects(serviceCommand('xero',{interactive:true}),/PKCE app/);
  await writeFile(join(process.env.BOARDROOM_CONNECTIONS_HOME,'xero-client.json'),JSON.stringify({client_id:'synthetic-client',token_endpoint_auth_method:'none'}));
  const command=await serviceCommand('xero',{interactive:true});assert.equal(command.args[2],'48132');assert.equal(command.args[1],'https://api.xero.com/mcp/v1');
  for(const name of ['send_invoice','create_refund','pay_bill','delete_customer','create_bill_payment'])assert.equal(serviceToolAllowed(name),false);
 }finally{if(previous===undefined)delete process.env.BOARDROOM_CONNECTIONS_HOME;else process.env.BOARDROOM_CONNECTIONS_HOME=previous;}
});
test('pinned QuickBooks server boots and lists real schemas without account authentication',async()=>{
 const previous=process.env.BOARDROOM_CONNECTIONS_HOME;process.env.BOARDROOM_CONNECTIONS_HOME=await temp();const broker=new ServiceConnections();
 try{
  const q=await prepare('quickbooks');await writeFile(q.file,'QUICKBOOKS_CLIENT_ID=fixture\nQUICKBOOKS_CLIENT_SECRET=fixture\nQUICKBOOKS_ENVIRONMENT=production\n');
  const result=await broker.list('quickbooks',{interactive:true,signal:AbortSignal.timeout(20000)});
  assert.ok(result.tools.length>10);assert.ok(result.tools.some(t=>t.name==='search_customers'));assert.ok(result.tools.some(t=>t.name==='get_profit_and_loss'));assert.ok(result.tools.every(t=>t.inputSchema?.type==='object'));
 }finally{await broker.close();if(previous===undefined)delete process.env.BOARDROOM_CONNECTIONS_HOME;else process.env.BOARDROOM_CONNECTIONS_HOME=previous;}
});
test('visual routing requires declared image support and favors an available economical route',async()=>{
 const llm={listProviders:()=>[{id:'provider'}],listModels:async()=>[{id:'expensive-pro',inputModalities:['image']},{id:'budget-mini',inputModalities:['image']}],resolveModelInfo:async()=>({inputModalities:['image']})};
 assert.equal((await selectVisionRoute(llm,{},null)).model,'budget-mini');
 await assert.rejects(selectVisionRoute({resolveModelInfo:async()=>({inputModalities:['text']})},{provider:'x',model:'text'}),/declares image input/);
});
test('current Stripe API tools preserve reads and restrict generic writes to supported preparation',()=>{
 for(const tool of ['stripe_api_read','stripe_api_search','stripe_api_details'])assert.equal(serviceToolAllowed(tool),true);
 assert.doesNotThrow(()=>validateStripeWrite('stripe_api_write',{api_method:'POST /v1/payment_links',parameters:{line_items:[{price:'synthetic',quantity:1}]}}));
 assert.doesNotThrow(()=>validateStripeWrite('stripe_api_write',{operationId:'PostProducts',parameters:{name:'Synthetic'}}));
 for(const args of [{api_method:'POST /v1/refunds',parameters:{}},{method:'DELETE',path:'/v1/customers',parameters:{}},{api_method:'POST /v1/invoices',parameters:{auto_advance:true}},{api_method:'unknown',parameters:{description:'POST /v1/products'}}])assert.throws(()=>validateStripeWrite('stripe_api_write',args));
});
test('visual evidence cannot complete without admitted images or after a screenshot changes',async()=>{
 const workspace=await temp(),entry=join(workspace,'index.html'),image=join(await temp(),'shot.png');await writeFile(entry,'test page');await writeFile(image,'test bytes');
 const check={workspaceHash:await workspaceDigest(workspace),entryPath:entry,entryHash:hash('test page'),views:[{screenshot:image,screenshotHash:hash(Buffer.from('test bytes').toString('base64')),viewport:{width:1200}},{screenshot:image+'2',screenshotHash:hash(Buffer.from('test bytes').toString('base64')),viewport:{width:390}}]};await writeFile(image+'2','test bytes');
 await assert.rejects(verifyVisualReview(workspace,{browserChecks:[check]}),/actual image admission/);
 const telemetry={browserChecks:[check],imagesViewed:check.views.map(x=>({path:x.screenshot,model:'fixture'}))};assert.equal((await verifyVisualReview(workspace,telemetry)).views.length,2);
 await writeFile(join(workspace,'style.css'),'body{color:red}');await assert.rejects(verifyVisualReview(workspace,telemetry),/actual image admission/);check.workspaceHash=await workspaceDigest(workspace);
 await writeFile(image,'changed');await assert.rejects(verifyVisualReview(workspace,telemetry),/screenshot changed/);
});
