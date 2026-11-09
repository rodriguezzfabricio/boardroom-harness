import {readFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';
import {assertObjectJsonSchema} from '@deepseek-ai/dsh-tools';
import {CAPABILITY_CATALOG} from './capabilities.mjs';
import {VERSION, schema} from './core.mjs';
import {taskSchema} from './mission-engine.mjs';
import {root} from './scripts/setup.mjs';
import {browserExecutable} from './workspace.mjs';

const checks = [];
async function check(name, fn) {
  try { const result = await fn(); checks.push({check: name, pass: result === true}); }
  catch (error) { checks.push({check: name, pass: false, error: error.message}); }
}
const require = createRequire(import.meta.url);
await check('Node 24', () => process.versions.node.split('.')[0] === '24');
await check('Pinned Harness adapter', () => require('@deepseek-ai/dsh-tools/package.json').version === '0.2.0-rc.2');
await check('Matching runtime version', async () => JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version === VERSION);
await check('Host-compatible schemas', () => { assertObjectJsonSchema(schema(['Decision'], ['company'])); assertObjectJsonSchema(taskSchema); return true; });
await check('SQLite storage', () => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE probe(id INTEGER)'); db.close(); return true; });
await check('Bundled capability skills', async () => {
  for (const name of new Set(CAPABILITY_CATALOG.flatMap(row => row.skills))) await access(join(root, 'skills', name, 'SKILL.md'));
  return true;
});
await check('Browser launch', async () => {
  const browser = await chromium.launch({headless: true, executablePath: await browserExecutable(chromium)});
  await browser.close(); return true;
});
const ok = checks.every(row => row.pass);
console.log(JSON.stringify({version: VERSION, ok, checks, scope: 'Package prerequisites. Credentials, an active chat, and external integrations are not tested.'}, null, 2));
if (!ok) { console.error('Install Node 24, run npm ci and npm run browser:install, then rerun npm run doctor.'); process.exitCode = 1; }
