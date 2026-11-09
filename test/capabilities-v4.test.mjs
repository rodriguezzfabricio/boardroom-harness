import assert from 'node:assert/strict';
import test from 'node:test';
import {CAPABILITY_CATALOG, capabilityInventory, compilePlan, normalizeBrief} from '../capabilities.mjs';
import {classifyIntent, composePlan, tasksFor} from '../recipes.mjs';

const mixed = 'Redesign the website, calculate runway from $12,000 cash and $3,000 monthly burn, and review the sales pipeline.';

function financePlan() {
  const outcome = 'A defensible cash runway calculation';
  return {
    brief: {outcomes: [outcome], constraints: [], acceptance: ['Use a stated burn period']},
    tasks: [
      {id: 'cash-runway', capabilityId: 'financial-analysis', dependencies: [], focus: 'Show the inputs and calculate runway.', outcomes: [outcome]},
      {id: 'check', capabilityId: 'independent-review', dependencies: ['cash-runway'], focus: 'Recompute and verify the result.', outcomes: [outcome]},
    ],
  };
}

test('catalog spans ten domains and returns detached, bounded skill and tool declarations', () => {
  const inventory = capabilityInventory();
  assert.deepEqual([...new Set(inventory.map(item => item.domain))].sort(),
    ['analytics', 'finance', 'legal', 'marketing', 'operations', 'product', 'research', 'sales', 'strategy', 'website']);
  assert.ok(inventory.length >= 12 && inventory.length <= 20);
  assert.equal(new Set(inventory.map(item => item.id)).size, inventory.length);
  assert.equal(inventory.filter(item => item.writesWorkspace).length, 1);
  for (const item of inventory) {
    assert.ok(item.skills.length >= 1 && item.skills.length <= 2);
    if (item.research) for (const name of ['web_search', 'web_fetch', 'research_read']) assert.ok(item.tools.includes(name));
    if (!item.writesWorkspace) assert.ok(!item.tools.includes('workspace_write'));
  }
  inventory[0].skills.push('made-up-skill');
  inventory[0].tools.length = 0;
  assert.deepEqual(capabilityInventory()[0], CAPABILITY_CATALOG[0]);
});

test('routing preserves website, finance, and sales and composes one reviewed mission', () => {
  const route = classifyIntent(mixed);
  assert.deepEqual([route.action, route.domain, route.domains, route.mode],
    ['plan', 'adaptive', ['website', 'finance', 'sales'], 'deliver']);
  const {tasks, brief} = compilePlan(composePlan({objective: mixed, domains: route.domains, mode: route.mode}), {mode: route.mode});
  assert.deepEqual(tasksFor('adaptive', route.mode, mixed), tasks);
  assert.deepEqual(tasks.filter(task => task.writesWorkspace).map(task => task.id), ['website-implementation']);
  assert.deepEqual(tasks.at(-1).dependencies, ['website-implementation', 'finance', 'sales']);
  assert.deepEqual(tasks.at(-1).outcomes, brief.outcomes);
  assert.ok(tasks.at(-1).tools.includes('browser_check'));
  assert.ok(tasks.some(task => task.capabilityId === 'financial-analysis'));
  assert.ok(tasks.some(task => task.capabilityId === 'sales-pipeline'));
  assert.equal(classifyIntent('Calculate cash runway with $12000 and $3000 monthly burn.').action, 'calculate');
  assert.equal(classifyIntent('Calculate runway from $12000 and $3000 monthly burn and recommend a buffer.').action, 'start');
  assert.equal(classifyIntent('Review the website and build a sales pipeline.').mode, 'advice');
  assert.equal(classifyIntent('Forecast the sales pipeline.').domain, 'sales');
  assert.equal(classifyIntent('Draft a product roadmap.').action, 'plan');
  assert.equal(classifyIntent('Help me with finance').action, 'clarify');
});

test('compiler derives permissions and normalizes text without sharing plan state', () => {
  const plan = financePlan();
  plan.tasks[0].focus = ' Show the inputs and calculate runway. ';
  plan.brief.acceptance[0] = ' Use a stated burn period ';
  const {tasks, brief} = compilePlan(plan);
  assert.deepEqual(brief, normalizeBrief(plan.brief));
  assert.equal(brief.acceptance[0], 'Use a stated burn period');
  assert.deepEqual(tasks[0], {
    id: 'cash-runway', kind: 'analyze', skills: ['financial-analyst'], dependencies: [],
    focus: 'Show the inputs and calculate runway.', difficulty: 'complex', research: false,
    status: 'pending', attempts: 0, capabilityId: 'financial-analysis',
    outcomes: ['A defensible cash runway calculation'], tools: ['boardroom_calculate', 'boardroom_economics'], writesWorkspace: false,
  });
  plan.tasks[0].outcomes[0] = 'A different deliverable';
  assert.equal(tasks[0].outcomes[0], brief.outcomes[0]);
  for (const field of ['skills', 'tools', 'writesWorkspace']) {
    const untrusted = financePlan();
    untrusted.tasks[0][field] = ['arbitrary'];
    assert.throws(() => compilePlan(untrusted), /Plan task must contain only/);
  }
});

test('compiler rejects invalid graphs and uncovered or unreviewed outcomes', () => {
  const reject = (edit, error) => {
    const plan = financePlan();
    edit(plan);
    assert.throws(() => compilePlan(plan), error);
  };
  reject(plan => { plan.tasks[0].capabilityId = 'unknown-skill'; }, /Unknown capability/);
  reject(plan => { plan.tasks[0].id = '../escaped'; }, /Invalid task ID/);
  reject(plan => { plan.tasks[1].id = 'cash-runway'; }, /Duplicate task IDs/);
  reject(plan => { plan.tasks[0].dependencies = ['check']; }, /dependency cycle/);
  reject(plan => { plan.tasks[1].dependencies = ['missing']; }, /missing dependency/);
  reject(plan => { plan.tasks[1].dependencies = ['cash-runway', 'cash-runway']; }, /duplicates/);
  reject(plan => { plan.tasks[1].dependencies = []; }, /final independent review/);
  reject(plan => { plan.tasks[0].outcomes.push('Invented'); }, /unknown brief outcome/);
  reject(plan => { plan.brief.outcomes.push('Another outcome'); }, /No work task covers outcome/);
  reject(plan => { plan.brief.outcomes.push('Another outcome'); plan.tasks[0].outcomes.push('Another outcome'); }, /Final review omits outcome/);
  reject(plan => { plan.tasks[0].focus = 'x'.repeat(3001); }, /focus must be a string/);
  reject(plan => { plan.tasks.length = 19; }, /Plan tasks must contain 2–18/);
});

test('workspace writers require delivery mode and independent browser verification', () => {
  const objective = 'Build a website';
  const plan = composePlan({objective, mode: 'deliver'});
  assert.throws(() => compilePlan(plan), /Workspace writes require deliver mode/);
  plan.tasks.at(-1).capabilityId = 'independent-review';
  assert.throws(() => compilePlan(plan, {mode: 'deliver'}), /browser-capable review/);
  plan.tasks[1].capabilityId = 'website-implement';
  assert.throws(() => compilePlan(plan, {mode: 'deliver'}), /at most one workspace writer/);
});
