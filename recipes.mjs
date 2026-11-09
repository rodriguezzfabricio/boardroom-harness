import {CAPABILITY_CATALOG, compilePlan} from './capabilities.mjs';

export const RECIPE_VERSION='2';
export const CAPABILITIES=Object.freeze(Object.fromEntries(
 [...new Set(CAPABILITY_CATALOG.map(item=>item.domain))].map(domain=>{
  const items=CAPABILITY_CATALOG.filter(item=>item.domain===domain);
  return [domain,Object.freeze({
   description:items.map(item=>item.description).join(' '),
   skills:Object.freeze([...new Set(items.flatMap(item=>item.skills))]),
  })];
 })
));

const fixedRecipes=new Set(['website','finance','strategy']);
const domainPatterns={
 website:/\b(?:website|web site|landing page|homepage|home page|web design|ux)\b|booking.*\b(?:site|page)\b|\b(?:site|page)\b.*book/,
 finance:/\b(?:financ\w*|pricing|prices?|cash|runway|margins?|profit\w*|economics|burn rate|budgets?|valuation|break[- ]even)\b|\brevenue\b(?! operations)/,
 strategy:/\b(?:business strategy|business model|strategic direction|competitive strategy|go.to.market strategy|options for the business)\b/,
 sales:/\b(?:sales|pipeline|prospect\w*|outreach|cold email|lead generation|lead qualification|sales enablement|deal desk|crm)\b/,
 marketing:/\b(?:marketing|campaigns?|advertis\w*|paid ads|seo|brand\w*|content strategy|content calendar|social media|positioning|go.to.market)\b/,
 product:/\b(?:product roadmap|product strategy|product discovery|product requirements|prd|feature priorit\w*|feature roadmap|backlog|onboarding flow)\b/,
 operations:/\b(?:operations?|revops|workflows?|sops?|standard operating procedure|handoffs?|process improvement|vendor management|fulfillment|staffing|customer support)\b/,
 legal:/\b(?:legal|contracts?|compliance|privacy policy|terms of service|nda|regulat\w*|liabilit\w*)\b/,
 analytics:/\b(?:analytics|measurement|instrumentation|metrics|kpis?|a\/?b test\w*|experiments?|tracking|dashboard)\b/,
 research:/\b(?:research|market sizing|competitor\w*|competitive intelligence|competitive analysis|customer interviews?|customer discovery|market trends)\b/,
};
const arithmetic=/\b(?:runway|margin|times|multiply|divide|add|subtract|profit|break[- ]even|calculate|economics)\b|\d\s*[+*/×÷]\s*\d/;

function matchedDomains(text){
 const domains=Object.keys(domainPatterns).filter(domain=>domainPatterns[domain].test(text));
 if(/\bforecast\w*\b/.test(text)&&!domains.includes('sales')&&!domains.includes('finance'))domains.push('finance');
 if(!domains.length&&/\bredesign\b/.test(text))domains.push('website');
 if(!domains.length&&/\d/.test(text)&&arithmetic.test(text))domains.push('finance');
 if(!domains.length&&/\b(?:strateg\w*|business|customers?|market|offer|growth|direction|priorit\w*|ideas?|plan|pilot|company)\b/.test(text))domains.push('strategy');
 return domains;
}

function requestsWebsiteDelivery(text){
 const clauses=text.split(/[;.!?]+|\s+(?:and(?: then)?|then|but|while)\s+(?=(?:also\s+)?(?:create|build|implement|redesign|rebuild|make|develop|assess|review|audit|analyze|calculate|write|draft|plan)\b)/);
 return clauses.some(clause=>{
  const request=clause.match(/\b(?:create|build|implement|redesign|rebuild|make|develop)\b/);
  if(!request||/\b(?:do not|don't|without|never)\b/.test(clause.slice(0,request.index)))return false;
  return domainPatterns.website.test(clause)||/\bredesign\b/.test(clause);
 });
}

export function classifyIntent(message,{domain,activeMission}={}){
 if(typeof message!=='string'||!message.trim()||message.length>8000)throw new Error('Provide an objective of 1–8000 characters');
 if(domain&&domain!=='adaptive'&&!Object.hasOwn(CAPABILITIES,domain))throw new Error('Unknown domain');
 const text=message.trim().toLowerCase();
 if(/^(status|progress|where are we)[?.!\s]*$/.test(text))return {action:'status',missionId:activeMission?.id??null};
 if(/^(stop|cancel|pause)[.!\s]*$/.test(text))return {action:text.startsWith('pause')?'pause':'cancel',missionId:activeMission?.id??null};
 if(activeMission&&!['accepted','cancelled'].includes(activeMission.status)&&!domain&&/^(continue|resume|keep|change|instead|make it|use the|actually|revise|but)\b/.test(text))return {action:/^(continue|resume)\b/.test(text)?'resume':'steer',domain:activeMission.domain,missionId:activeMission.id};
 const matched=matchedDomains(text);
 const domains=domain&&domain!=='adaptive'?[...new Set([domain,...matched])]:matched;
 const selected=domain==='adaptive'||domains.length>1?'adaptive':domains[0];
 if(!selected||(!domain&&/^(can you |help (me )?(with )?|let'?s (talk|discuss)( about )?|about |our |my |the |\s)*(finance|finances)[?.!\s]*$/.test(text)))return {action:'clarify',question:selected==='finance'?'Is this about company finances or personal finances?':'What outcome should we work toward?',candidates:Object.keys(CAPABILITIES)};
 const direct=selected==='finance'&&!/\b(?:compare|forecast|strategy|recommend|should|research|evaluate|assess|advise|suggest|decide|plan|model|also|report|prepare|write|create|draft|chart)\b/.test(text)&&/\d/.test(text)&&arithmetic.test(text);
 const mode=domains.includes('website')&&requestsWebsiteDelivery(text)?'deliver':'advice';
 const action=direct?'calculate':fixedRecipes.has(selected)?'start':'plan';
 return {action,domain:selected,domains,mode,reason:domain?'Controller supplied domain context':'Matched task intent; foreground controller resolves ambiguity',recipeVersion:RECIPE_VERSION,requiresClarification:false};
}

const domainWork={
 finance:{outcome:'Financial analysis with explicit inputs, assumptions, and implications',capabilityId:'financial-analysis',focus:'Analyze the requested financial question. Show units, periods, material assumptions, and verified arithmetic.'},
 strategy:{outcome:'Business options and decision criteria',capabilityId:'business-strategy',focus:'Compare realistic options, tradeoffs, and assumptions using the company context.'},
 sales:{outcome:'Sales analysis or a sales deliverable for review',capabilityId:'sales-pipeline',focus:'Analyze the requested pipeline or sales process. Identify evidence gaps and prioritize next steps.'},
 marketing:{outcome:'Marketing deliverable with audience, channels, and measurement',capabilityId:'marketing-plan',focus:'Develop the requested marketing deliverable and connect it to the target audience, channels, and measurement.'},
 product:{outcome:'Product deliverable with priorities and outcome measures',capabilityId:'product-plan',focus:'Develop the requested product deliverable. Connect user needs, priorities, and measurable outcomes.'},
 operations:{outcome:'Operations assessment and proposed workflow changes',capabilityId:'operations-plan',focus:'Assess the requested workflow or operational issue. Identify constraints, owners, and verifiable improvements.'},
 legal:{outcome:'Legal issues and evidence requiring review',capabilityId:'legal-assessment',focus:'Review the legal question, identify material issues and missing jurisdiction or facts, and cite applicable primary sources.'},
 analytics:{outcome:'Measurement or analytical deliverable with data and assumptions',capabilityId:'analytics-plan',focus:'Deliver the requested analysis or measurement design. State data needs, definitions, and verification steps.'},
 research:{outcome:'Research findings with source coverage and limitations',capabilityId:'market-research',focus:'Investigate the requested research question using current primary sources. Separate supported findings from gaps.'},
};

export function composePlan({objective,domains,mode='advice'}){
 if(typeof objective!=='string'||!objective.trim()||objective.length>8000)throw new Error('Provide an objective of 1–8000 characters');
 if(!['advice','deliver'].includes(mode))throw new Error('Invalid mission mode');
 const requested=domains??matchedDomains(objective.toLowerCase());
 if(!Array.isArray(requested)||!requested.length||Array.from(requested).some(domain=>typeof domain!=='string'||!Object.hasOwn(CAPABILITIES,domain)))throw new Error('Choose catalog domains or supply an explicit plan');
 const tasks=[],outcomes=[],leaves=[];
 for(const domain of new Set(requested)){
  if(domain==='website'){
   const outcome=mode==='deliver'?'Local website artifact with browser verification':'Website assessment and design guidance';
   outcomes.push(outcome);
   tasks.push(
    {id:'website-inspect',capabilityId:'website-inspect',dependencies:[],focus:'Inspect the supplied website or brief for conversion barriers, accessibility, and content gaps.',outcomes:[outcome]},
    {id:'website-design',capabilityId:'website-design',dependencies:['website-inspect'],focus:'Combine the findings into a concrete website design with acceptance checks.',outcomes:[outcome]},
   );
   if(mode==='deliver')tasks.push({id:'website-implementation',capabilityId:'website-implement',dependencies:['website-design'],focus:'Build the requested local artifact in the mission workspace. Preserve required behavior and use existing facts.',outcomes:[outcome]});
   leaves.push(tasks.at(-1).id);
   continue;
  }
  const work=domainWork[domain];
  const pricing=domain==='finance'&&/\b(?:pricing|prices?|packaging|rates)\b/i.test(objective);
  const salesDraft=domain==='sales'&&/\b(?:draft|write|collateral|script|enablement|outreach|cold email)\b/i.test(objective);
  const capabilityId=pricing?'pricing-analysis':salesDraft?'sales-enablement':work.capabilityId;
  const focus=pricing?'Compare the requested pricing or packaging options. Show assumptions and check material current facts.':salesDraft?'Prepare the requested sales draft or collateral for review. Ground claims in supplied evidence.':work.focus;
  tasks.push({id:domain,capabilityId,dependencies:[],focus,outcomes:[work.outcome]});
  outcomes.push(work.outcome);
  leaves.push(domain);
 }
 const website=requested.includes('website');
 tasks.push({
  id:'verification',capabilityId:website?'website-review':'independent-review',dependencies:leaves,
  focus:'Review every requested outcome and upstream work product against the brief. Identify material gaps, cross-domain contradictions, and unsupported claims.'+(website&&mode==='deliver'?' Run browser_check on the delivered website.':''),
  outcomes:[...outcomes],
 });
 return {tasks,brief:{outcomes,constraints:['Use supplied facts and clearly label assumptions or missing evidence.'],acceptance:['Every requested outcome has a concrete deliverable and independent verification.']}};
}

export function tasksFor(domain,mode='advice',objective=''){
 const task=(id,kind,skills,dependencies,focus,difficulty='routine',research=false)=>({id,kind,skills,dependencies,focus,difficulty,research,status:'pending',attempts:0});
 if(domain==='website'){
  const tasks=[
   task('ux','inspect',['cro'],[],'Inspect user journey, conversion barriers, accessibility, and the existing brief. Return specific evidence and acceptance criteria.'),
   task('content','inspect',['copywriting'],[],'Inspect positioning, audience, content hierarchy, proof and calls to action. Never invent testimonials or business facts.'),
   task('design','synthesize',['frontend-design'],['ux','content'],'Combine the independent findings into one implementable design brief. Preserve accepted constraints and identify missing decisions.','complex'),
  ];
  if(mode==='deliver')tasks.push(task('implementation','implement',['frontend-design'],['design'],'Build the requested website artifact in the isolated workspace using workspace tools. Prefer a complete self-contained HTML/CSS/JS prototype when no application is supplied. Do not create placeholder claims or silently remove existing functionality.','complex'));
  tasks.push(task('verification','review',['frontend-design'],[mode==='deliver'?'implementation':'design'],'Verify the deliverable against the objective and upstream findings. For implementation, run browser_check; inspect functional results and report visual review limitations. Request bounded corrections when needed.','complex'));
  return tasks;
 }
 if(domain==='finance')return [
  task('finance','analyze',['financial-analyst'],[],'Analyze the financial question. Use boardroom_economics or boardroom_calculate for arithmetic; state units, periods, assumptions, cash exposure, and missing inputs.',/compare|forecast|scenario|valuation|strategy|risk|pricing/i.test(objective)?'complex':'routine'),
  ...(/competitor|market|current|price|pricing|rates/i.test(objective)?[task('market-evidence','research',['pricing-strategist'],[],'Retrieve primary current evidence relevant to the financial decision. Record dates, scope, units, and conflicting evidence.','routine',true)]:[]),
  task('verification','review',['pm-strategy-red-team'],/competitor|market|current|price|pricing|rates/i.test(objective)?['finance','market-evidence']:['finance'],'Independently verify calculations and evidence support. Distinguish assumptions from facts and challenge the decision, not the formatting.','complex'),
 ];
 if(domain==='strategy')return [
  task('options','analyze',['pm-business-model'],[],'Frame the business decision and compare a small set of realistic options, using accepted decisions and constraints.'),
  task('verification','review',['pm-strategy-red-team'],['options'],'Check material claims, contradictions, decisive assumptions, and the cheapest useful next test. Counsel the user without approving their decisions.','complex'),
 ];
 if(domain==='adaptive'||Object.hasOwn(CAPABILITIES,domain))return compilePlan(composePlan({objective,domains:domain==='adaptive'?undefined:[domain],mode}),{mode}).tasks;
 throw new Error('Unknown recipe');
}
export function affectedTasks(tasks,roots){
 const affected=new Set(roots??tasks.map(t=>t.id));
 for(const id of affected)if(!tasks.some(t=>t.id===id))throw new Error('Unknown affected task: '+id);
 let changed=true;while(changed){changed=false;for(const task of tasks)if(!affected.has(task.id)&&task.dependencies.some(id=>affected.has(id))){affected.add(task.id);changed=true;}}
 return affected;
}
export function calculate({operation,cashCents,burnCents,period='month',left,right}){
 if(operation==='runway'){
  if(!Number.isSafeInteger(cashCents)||cashCents<0||!Number.isSafeInteger(burnCents)||burnCents<0)throw new Error('Cash and net burn must be nonnegative integer cents');
  if(!['month','week','day'].includes(period))throw new Error('Explicit burn period must be month, week, or day');
  return {periods:burnCents===0?null:cashCents/burnCents,period,assumptions:'Constant user-supplied net burn; no new financing or unexpected cash flows.',note:burnCents===0?'No finite runway limit under zero net burn.':null};
 }
 if(!['add','subtract','multiply','divide','margin'].includes(operation)||![left,right].every(Number.isFinite))throw new Error('Use a supported operation and finite numeric inputs');
 if((operation==='divide'||operation==='margin')&& (operation==='margin'?left:right)===0)throw new Error('Undefined zero denominator');
 const value=operation==='add'?left+right:operation==='subtract'?left-right:operation==='multiply'?left*right:operation==='divide'?left/right:100*(left-right)/left;
 if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw new Error('Result exceeds supported numeric range');
 return {value,unit:operation==='margin'?'percent':'same units implied by inputs',assumptions:'User-supplied inputs; margin uses revenue as left and cost as right.'};
}
