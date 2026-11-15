import {access, readFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {configure, parseArgs, help} from './setup.mjs';

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(help.replace('setup', 'start'));
  else {
    const config = await configure(options);
    const host = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'));
    const manifest = JSON.parse(await readFile(join(host, 'package.json'), 'utf8'));
    if (manifest.version !== '0.2.0-rc.2') throw new Error('Unsupported Harness version; reinstall the locked dependencies with npm ci.');
    const profile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', config.profile, 'package.json');
    let initialize = false;
    try { await access(profile); } catch (error) { if (error.code !== 'ENOENT') throw error; initialize = true; }
    const args = [join(host, manifest.bin.dsh), '--profile', config.profile];
    if (initialize) args.push('--from-default-profile', 'web');
    args.push('--patch', config.patch);
    console.log('Launching Boardroom. Open a new chat in one of the configured project folders and enter /boardroom.');
    const child = spawn(process.execPath, args, {cwd: config.projects[0], stdio: 'inherit'});
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
