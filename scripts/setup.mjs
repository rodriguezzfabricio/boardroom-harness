import {readFile, writeFile, mkdir, readdir, lstat, realpath} from 'node:fs/promises';
import {dirname, join, resolve, parse as parsePath} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {stringify} from 'yaml';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function parseArgs(args) {
  const projects = []; let profile = 'boardroom';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return {help: true};
    if (!['--project', '--profile'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Use --project /path/to/project (repeatable) and optional --profile NAME.');
    }
    const value = args[++i];
    if (arg === '--project') projects.push(resolve(value)); else profile = value;
  }
  if (!projects.length) throw new Error('Supply at least one --project path.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) throw new Error('Invalid profile name.');
  return {projects: [...new Set(projects)], profile};
}

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Never traverse a project-owned symlink while placing workflow files.
async function checkParents(base, path) {
  for (let current = path; current !== dirname(base); current = dirname(current)) {
    const stat = await exists(current);
    if (stat?.isSymbolicLink()) throw new Error('Setup refuses a symlink destination: ' + current);
    if (stat && !stat.isDirectory()) throw new Error('Expected directory: ' + current);
    if (current === base) break;
  }
}

async function tree(path, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(path, prefix), {withFileTypes: true})) {
    const name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Bundled skills must not contain symlinks.');
    if (entry.isDirectory()) files.push(...await tree(path, name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

export async function configure({projects, profile = 'boardroom'}, {outputDir = join(root, '.local')} = {}) {
  const canonical = [];
  for (const project of projects) {
    await mkdir(resolve(project), {recursive: true});
    const path = await realpath(resolve(project));
    if (path === parsePath(path).root || path === root) throw new Error('Choose a separate project directory.');
    canonical.push(path);
  }
  projects = [...new Set(canonical)];
  const skillFiles = await tree(join(root, 'skills'));
  const pending = [];
  for (const project of projects) {
    const skillRoot = join(project, '.agents', 'skills');
    const candidates = skillFiles.filter(name => name !== 'manifest.json').map(name => ({
      source: join(root, 'skills', name), target: join(skillRoot, name), preserve: false
    }));
    for (const name of ['COMPANY.md', 'STATE.md', 'DECISIONS.md']) candidates.push({
      source: join(root, 'templates', name), target: join(skillRoot, 'boardroom', name), preserve: true
    });
    candidates.push({target: join(skillRoot, 'boardroom', '.gitignore'), preserve: true,
      data: Buffer.from('.runtime/\nout/\nCOMPANY.md\nSTATE.md\nDECISIONS.md\n*.bak\n')});
    for (const item of candidates) {
      await checkParents(project, dirname(item.target));
      const stat = await exists(item.target);
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Unsafe destination: ' + item.target);
      if (stat && item.preserve) continue;
      const data = item.data ?? await readFile(item.source);
      if (stat) {
        if (!(await readFile(item.target)).equals(data)) throw new Error(
          'Existing skill differs: ' + item.target + '. No files were replaced. Use a fresh project or reconcile the skill explicitly.');
      } else pending.push({...item, data});
    }
  }
  // All conflicts are checked before any skill or business record is written.
  for (const {target, data} of pending) {
    await mkdir(dirname(target), {recursive: true, mode: 0o700});
    await writeFile(target, data, {flag: 'wx', mode: 0o600});
  }
  if ((await exists(outputDir))?.isSymbolicLink()) throw new Error('Setup refuses a symlink for the patch directory.');
  await mkdir(outputDir, {recursive: true, mode: 0o700});
  const digest = createHash('sha256').update(JSON.stringify({projects, profile, root})).digest('hex').slice(0, 16);
  const patch = join(outputDir, `${profile}-${digest}.patch.yml`);
  const content = stringify([{insert: [{id: 'boardroom-runtime', name: join(root, 'plugin.mjs'), config: {projects}}]}]);
  const existing = await exists(patch);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('Unsafe patch destination.');
  if (!existing) await writeFile(patch, content, {flag: 'wx', mode: 0o600});
  else if (await readFile(patch, 'utf8') !== content) throw new Error('Generated patch was modified; inspect it before setup.');
  return {projects, profile, patch, createdFiles: pending.length};
}

export const help = 'Usage: npm run setup -- --project /path/to/project [--project /path/to/second] [--profile boardroom]';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(help);
    else {
      const result = await configure(options);
      console.log(JSON.stringify(result, null, 2));
      console.log('Setup complete. Start with npm start followed by the same --project and --profile arguments.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
