import { spawn } from 'node:child_process';
import { CliError } from './errors.js';
import { ORIGINS } from './client.js';

export function browserCommand(uri, platform = process.platform) {
  if (!Object.values(ORIGINS).some(origin => uri === `${origin}/fogipass/settings/connections/authorize`)) {
    throw new CliError('invalid_arguments', 'Invalid authorization URL.');
  }
  if (platform === 'darwin') return ['/usr/bin/open', [uri]];
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', uri]];
  return ['xdg-open', [uri]];
}

export async function openBrowser(uri) {
  const [command, args] = browserCommand(uri);
  return new Promise(resolve => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5000);
    const done = ok => { clearTimeout(timer); resolve(ok); };
    child.once('error', () => done(false));
    child.once('exit', code => done(code === 0));
  });
}

export function binding(value) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=([a-f0-9]{24}):([a-z_]{1,64})$/.exec(value);
  if (!match) throw new CliError('invalid_arguments', 'Use --env VARIABLE=ITEM_ID:FIELD.');
  const [, name, id, field] = match;
  const upper = name.toUpperCase();
  if (['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'HOME', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'IFS', 'ZDOTDIR'].includes(upper)
    || /^(LD_|DYLD_|NODE_|NAPI_RS_|PYTHON|GIT_|NPM_|BASH_FUNC_)/.test(upper)) {
    throw new CliError('invalid_arguments', 'Runtime-control environment variables cannot contain vault values.');
  }
  return { name, id, field };
}

export async function runChild(program, env, signal) {
  if (!program.length || !program[0] || /\.(cmd|bat)$/i.test(program[0])) {
    throw new CliError('invalid_arguments', 'Provide an executable after --. Windows .cmd/.bat files are not supported; run the underlying executable directly.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(program[0], program.slice(1), { env, shell: false, stdio: 'inherit', signal });
    child.once('error', error => {
      if (error.name === 'AbortError') reject(error);
      else reject(new CliError('command_failed', 'Could not start the requested executable.'));
    });
    child.once('exit', (code, stopped) => resolve(code ?? (stopped === 'SIGINT' ? 130 : 1)));
  });
}
