import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {assertUserDecision} from '../authority.mjs';
import {MissionEngine} from '../mission-engine.mjs';
import {MissionStore, memoryQuery} from '../mission-store.mjs';
import {composePlan} from '../recipes.mjs';

function userSession(text) {
  const event = {seq: 42, type: 'user/message', data: {source: {kind: 'user'}, content: [{type: 'text', text}]}};
  return {id: 'chat', session: {header: {id: 'chat'}, snapshotEvents: () => [event]}};
}

test('quoting the complete message does not authorize unrelated state changes', () => {
  const target = {targetId: 'unrelated-record', revision: 99};
  const examples = [
    ['Did we approve the artifact?', 'accept'],
    ['Yes, show me pricing options', 'accept'],
    ['Can you explain why we should use a flat price?', 'adopt'],
  ];
  for (const [text, action] of examples) {
    assert.throws(() => assertUserDecision(userSession(text), text, {...target, action}), text);
  }
});

test('an explicit acceptance belongs to the current session event', () => {
  const text = 'I accept the report.';
  const options = {targetId: 'mission', revision: 2, action: 'accept'};
  const agent = userSession(text);
  assert.equal(assertUserDecision(agent, text, options).eventId, 42);
  agent.session.isOwnSeq = () => false;
  assert.throws(() => assertUserDecision(agent, text, options), /inherited history/);
});

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'boardroom-v4-review-')));
  const store = new MissionStore(dir);
  t.after(async () => {
    await store.close();
    await rm(dir, {recursive: true, force: true});
  });
  return store;
}

test('adopting memory during review reruns completed work with the same new snapshot', {timeout: 4000}, async t => {
  const store = await fixture(t);
  const mission = await store.create({domain: 'strategy', objective: 'Compare pilot strategy', owner: 'review', context: {}});
  const outcomes = [];
  const {promise: reached, resolve: reachedReview} = Promise.withResolvers();
  const {promise: wait, resolve: releaseReview} = Promise.withResolvers();
  const engine = new MissionEngine({
    store,
    prepare: async (m, task) => ({memorySnapshot: await store.consumedMemory(memoryQuery(m, task))}),
    execute: async (m, task, {binding}) => {
      outcomes.push({id: task.id, revision: m.revision, memory: binding.memorySnapshot.records.map(row => row.text)});
      if (task.id === 'verification' && m.revision === 1) {
        reachedReview();
        await wait;
      }
      return {value: {summary: 'Verified pilot strategy', claims: [], artifacts: [], verdict: 'complete', issues: []}};
    },
  });
  const running = engine.run(mission.id, {owner: 'review'});
  const text = 'Set the pilot to $100';
  try {
    await Promise.race([reached, running.then(() => assert.fail('Engine did not reach review'))]);
    const memory = await store.recordDecision({key: 'pilot-price', text, sourceEvent: {text, eventId: 42, sessionId: 'chat'}});
    assert.deepEqual(memory.affectedMissions, [mission.id]);
    engine.interrupt(mission.id);
  } finally {
    releaseReview();
  }
  const result = await running;
  assert.equal(result.status, 'review-ready');
  assert.deepEqual(outcomes, [
    {id: 'options', revision: 1, memory: []},
    {id: 'verification', revision: 1, memory: []},
    {id: 'options', revision: 2, memory: [text]},
    {id: 'verification', revision: 2, memory: [text]},
  ]);
});

test('a replan cannot overwrite a newer correction, and a refreshed plan preserves it', async t => {
  const store = await fixture(t);
  const objective = 'Assess the sales pipeline';
  const plan = composePlan({objective});
  const original = await store.create({domain: 'adaptive', objective, plan, owner: 'review', context: {}});
  const message = 'Use only US pipeline records';
  const steered = await store.steer(original.id, {message, affected: ['sales']});
  plan.tasks[0].focus = 'Show pipeline stage conversion ratios.';
  await assert.rejects(store.patchPlan(original.id, {expectedRevision: original.planRevision, plan, reason: 'Previous draft'}), /stale/);
  const patched = await store.patchPlan(original.id, {expectedRevision: steered.planRevision, plan, reason: 'User asked for conversion ratios'});
  assert.ok(patched.tasks.find(task => task.id === 'sales').instructions.includes(message));
});
