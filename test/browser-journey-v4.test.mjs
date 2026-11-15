import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {browserCheck,validateBrowserSteps} from '../workspace.mjs';

async function site(t,body){
 const root=await realpath(await mkdtemp(join(tmpdir(),'boardroom-browser-journey-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const artifactDir=join(root,'artifacts');
 await mkdir(artifactDir);
 await writeFile(join(root,'index.html'),`<!doctype html><html><head><title>Pilot fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Try the pilot</h1>${body}</body></html>`);
 return {root,artifactDir};
}

test('browser journey verifies a functional toggle, input, and URL in fresh desktop and mobile views',{timeout:20000},async t=>{
 const {root,artifactDir}=await site(t,`
  <button id="open" type="button">Pilot details</button>
  <section id="details" hidden>
   <label>Email <input id="email" type="email"></label>
   <p id="status" role="status"></p>
  </section>
  <script>
   const details=document.querySelector('#details');
   document.querySelector('#open').addEventListener('click',()=>details.hidden=!details.hidden);
   document.querySelector('#email').addEventListener('keydown',event=>{
    if(event.key!=='Enter')return;
    document.querySelector('#status').textContent='Email saved locally';
    history.replaceState(null,'','?status=saved#details');
   });
  </script>`);
 const steps=[
  {action:'click',selector:'#open'},
  {action:'assert-visible',selector:'#details'},
  {action:'fill',selector:'#email',value:'pilot@example.test'},
  {action:'assert-value',selector:'#email',value:'pilot@example.test'},
  {action:'press',selector:'#email',key:'Enter'},
  {action:'assert-text',selector:'#status',text:'Email saved locally'},
  {action:'assert-url',path:'/index.html?status=saved#details'},
 ];
 const result=await browserCheck(root,{artifactDir,steps});
 assert.equal(result.renderPassed,true);
 assert.equal(result.functionalVerified,true);
 assert.equal(result.passed,true);
 assert.deepEqual(result.views.map(v=>v.viewport.width),[1440,390]);
 for(const view of result.views){
  assert.equal(view.journey.requestedSteps,steps.length);
  assert.equal(view.journey.passed,true);
  assert.deepEqual(view.journey.steps.map(step=>step.passed),steps.map(()=>true));
 }
});

test('browser journey catches a planted inert control despite successful rendering',{timeout:25000},async t=>{
 const {root,artifactDir}=await site(t,'<button id="open">Pilot details</button><section id="details" hidden>Details</section>');
 const result=await browserCheck(root,{artifactDir,steps:[{action:'click',selector:'#open'},{action:'assert-visible',selector:'#details'}]});
 assert.equal(result.renderPassed,true);
 assert.equal(result.passed,false);
 assert.equal(result.functionalVerified,false);
 for(const view of result.views){
  assert.equal(view.journey.passed,false);
  assert.deepEqual(view.journey.steps.map(step=>step.passed),[true,false]);
 }
});

test('browser journey blocks off-origin navigation and static checks do not verify functionality',{timeout:20000},async t=>{
 const {root,artifactDir}=await site(t,'<a href="https://outside.invalid/pilot">External pilot</a>');
 const staticRender=await browserCheck(root,{artifactDir});
 assert.equal(staticRender.passed,true);
 assert.equal(staticRender.functionalVerified,false);
 assert.ok(staticRender.views.every(view=>view.journey.passed===null));
 const result=await browserCheck(root,{artifactDir,steps:[{action:'click',selector:'a'}]});
 assert.equal(result.renderPassed,true);
 assert.equal(result.passed,false);
 assert.ok(result.views.every(view=>view.journey.passed===false));
 assert.deepEqual([...new Set(result.blockedNavigations.map(item=>item.viewport))],[1440,390]);
});

test('browser journey validates declarative steps before touching the workspace',async()=>{
 await assert.rejects(browserCheck('/missing',{steps:[{action:'evaluate',script:'document.body.remove()'}]}),/Unsupported browser journey step/);
 assert.throws(()=>validateBrowserSteps([{action:'click',selector:'button',script:'window.open()'}]),/Unsupported browser journey step/);
 assert.throws(()=>validateBrowserSteps([{action:'assert-url',path:'//outside.invalid/pilot'}]),/local absolute path/);
 assert.throws(()=>validateBrowserSteps(Array.from({length:13},()=>({action:'click',selector:'button'}))),/at most 12/);
});
