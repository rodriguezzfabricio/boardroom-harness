const workspaceRead = ['workspace_list', 'workspace_read'];
const webResearch = ['web_search', 'web_fetch', 'research_read'];
const calculations = ['boardroom_calculate', 'boardroom_economics'];

function capability(id, domain, description, skills, kind, options = {}) {
  return Object.freeze({
    id, domain, description, skills: Object.freeze(skills), kind,
    difficulty: options.difficulty ?? 'routine',
    research: options.research ?? false,
    tools: Object.freeze(options.tools ?? []),
    writesWorkspace: options.writesWorkspace ?? false,
  });
}

// Tools here are capability-specific additions to common worker reference and artifact tools.
export const CAPABILITY_CATALOG = Object.freeze([
  capability('website-inspect', 'website', 'Inspect website conversion, usability, copy, and supplied project files.', ['cro', 'copywriting'], 'inspect', {tools: workspaceRead}),
  capability('website-design', 'website', 'Synthesize a website brief or design with concrete acceptance checks.', ['frontend-design'], 'synthesize', {difficulty: 'complex', tools: workspaceRead}),
  capability('website-implement', 'website', 'Implement a local website artifact and run scoped local checks.', ['frontend-design'], 'implement', {difficulty: 'complex', tools: [...workspaceRead, 'workspace_write', 'browser_check', 'bash'], writesWorkspace: true}),
  capability('website-review', 'website', 'Independently review website work and verify delivered local artifacts in a browser.', ['frontend-design', 'pm-strategy-red-team'], 'review', {difficulty: 'complex', tools: [...workspaceRead, ...calculations, 'browser_check', 'bash']}),
  capability('financial-analysis', 'finance', 'Analyze supplied cash flow, unit economics, margins, and financial scenarios.', ['financial-analyst'], 'analyze', {difficulty: 'complex', tools: calculations}),
  capability('pricing-analysis', 'finance', 'Compare pricing or packaging options using current primary evidence when needed.', ['pricing-strategist', 'financial-analyst'], 'analyze', {difficulty: 'complex', research: true, tools: [...calculations, ...webResearch]}),
  capability('business-strategy', 'strategy', 'Frame business decisions, compare models, and identify risks and decision criteria.', ['pm-business-model'], 'analyze', {difficulty: 'complex', tools: calculations}),
  capability('sales-pipeline', 'sales', 'Analyze leads, pipeline, funnel stages, and forecast assumptions using supplied data.', ['kwp-sales-pipeline-review'], 'analyze', {tools: calculations}),
  capability('sales-enablement', 'sales', 'Prepare sales collateral, call guidance, or outreach drafts for review.', ['sales-enablement'], 'synthesize'),
  capability('marketing-plan', 'marketing', 'Plan positioning, channels, campaigns, content, and measurement.', ['marketing-plan'], 'synthesize'),
  capability('product-plan', 'product', 'Develop product strategy, requirements, priorities, and an outcome roadmap.', ['pm-product-strategy', 'pm-outcome-roadmap'], 'synthesize', {difficulty: 'complex'}),
  capability('operations-plan', 'operations', 'Assess business operations, workflow handoffs, and process improvements.', ['kwp-smb-business-pulse', 'revops'], 'analyze'),
  capability('legal-assessment', 'legal', 'Review supplied terms or a compliance question and research applicable primary sources.', ['kwp-legal-compliance-check', 'kwp-smb-contract-review'], 'analyze', {difficulty: 'complex', research: true, tools: webResearch}),
  capability('analytics-plan', 'analytics', 'Analyze supplied metrics or design measurement and experiments.', ['analytics', 'experiment-design'], 'analyze', {tools: calculations}),
  capability('market-research', 'research', 'Research customer, competitor, or market questions with traceable sources.', ['customer-research', 'pm-competitor-analysis'], 'research', {research: true, tools: webResearch}),
  capability('independent-review', 'strategy', 'Independently challenge peer evidence, arithmetic, coverage, and acceptance checks.', ['pm-strategy-red-team'], 'review', {difficulty: 'complex', tools: calculations}),
]);

const byCapability = new Map(CAPABILITY_CATALOG.map(item => [item.id, item]));
const taskLimit = 18;
const safeId = /^[a-zA-Z0-9_-]{1,64}$/;

export function capabilityInventory() {
  return CAPABILITY_CATALOG.map(item => ({...item, skills: [...item.skills], tools: [...item.tools]}));
}

function requireFields(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${name} must contain only ${fields.join(', ')}`);
  }
}

function boundedText(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a string of 1–${max} characters`);
  }
  return value.trim();
}

function boundedList(value, min, max, parse, name) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${name} must contain ${min}–${max} entries`);
  }
  const entries = Array.from(value, parse);
  if (new Set(entries).size !== entries.length) throw new Error(`${name} contains duplicates`);
  return entries;
}

function taskId(value) {
  if (typeof value !== 'string' || !safeId.test(value)) throw new Error('Invalid task ID');
  return value;
}

export function normalizeBrief(brief) {
  requireFields(brief, ['outcomes', 'constraints', 'acceptance'], 'Plan brief');
  const briefList = (name, min) => boundedList(brief[name], min, taskLimit,
    entry => boundedText(entry, 800, `Brief ${name} entry`), `Brief ${name}`);
  return {outcomes: briefList('outcomes', 1), constraints: briefList('constraints', 0), acceptance: briefList('acceptance', 1)};
}

export function compilePlan(plan, {mode = 'advice'} = {}) {
  if (!['advice', 'deliver'].includes(mode)) throw new Error('Invalid mission mode');
  requireFields(plan, ['tasks', 'brief'], 'Plan');
  const brief = normalizeBrief(plan.brief);

  const tasks = boundedList(plan.tasks, 2, taskLimit, raw => {
    requireFields(raw, ['id', 'capabilityId', 'dependencies', 'focus', 'outcomes'], 'Plan task');
    const id = taskId(raw.id);
    const item = byCapability.get(raw.capabilityId);
    if (!item) throw new Error(`Unknown capability for task ${id}`);
    const outcomes = boundedList(raw.outcomes, 1, taskLimit,
      entry => boundedText(entry, 800, `${id} outcome`), `${id} outcomes`);
    if (outcomes.some(outcome => !brief.outcomes.includes(outcome))) throw new Error(`Task ${id} references an unknown brief outcome`);
    return {
      id, capabilityId: item.id, kind: item.kind, skills: [...item.skills],
      dependencies: boundedList(raw.dependencies, 0, taskLimit - 1, taskId, `${id} dependencies`),
      focus: boundedText(raw.focus, 3000, `${id} focus`), difficulty: item.difficulty,
      research: item.research, status: 'pending', attempts: 0,
      outcomes, tools: [...item.tools], writesWorkspace: item.writesWorkspace,
    };
  }, 'Plan tasks');

  const byTask = new Map(tasks.map(task => [task.id, task]));
  if (byTask.size !== tasks.length) throw new Error('Duplicate task IDs');
  const writers = tasks.filter(task => task.writesWorkspace);
  if (writers.length > 1) throw new Error('A plan may have at most one workspace writer');
  if (writers.length && mode !== 'deliver') throw new Error('Workspace writes require deliver mode');

  const visited = new Map();
  function ancestors(task) {
    if (visited.has(task.id)) {
      const saved = visited.get(task.id);
      if (!saved) throw new Error(`Task dependency cycle at ${task.id}`);
      return saved;
    }
    visited.set(task.id, null);
    const upstream = new Set();
    for (const id of task.dependencies) {
      const dependency = byTask.get(id);
      if (!dependency) throw new Error(`Task ${task.id} references missing dependency ${id}`);
      upstream.add(id);
      for (const ancestor of ancestors(dependency)) upstream.add(ancestor);
    }
    visited.set(task.id, upstream);
    return upstream;
  }
  for (const task of tasks) ancestors(task);

  const finalReview = tasks.find(task => task.kind === 'review' && ancestors(task).size === tasks.length - 1);
  if (!finalReview) throw new Error('A final independent review must depend on every other task directly or transitively');
  const producers = tasks.filter(task => task.kind !== 'review');
  const covered = new Set(producers.flatMap(task => task.outcomes));
  for (const outcome of brief.outcomes) {
    if (!covered.has(outcome)) throw new Error(`No work task covers outcome: ${outcome}`);
    if (!finalReview.outcomes.includes(outcome)) throw new Error(`Final review omits outcome: ${outcome}`);
  }
  if (writers.length && !tasks.some(task => task.kind === 'review' && task.tools.includes('browser_check') && ancestors(task).has(writers[0].id))) {
    throw new Error('Website implementation requires a browser-capable review downstream of the workspace writer');
  }
  return {tasks, brief};
}
