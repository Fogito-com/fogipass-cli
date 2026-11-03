import { spawn } from 'node:child_process';
import { CliError } from './errors.js';
import { ORIGINS, validateField } from './client.js';

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
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=([a-f0-9]{24}):([a-z_][a-z0-9_]{0,63})$/.exec(value);
  if (!match) throw new CliError('invalid_arguments', 'Use --env VARIABLE=ITEM_ID:FIELD.');
  const [, name, id, field] = match;
  validateField(field);
  const upper = name.toUpperCase();
  if (['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'HOME', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'IFS', 'ZDOTDIR'].includes(upper)
    || /^(LD_|DYLD_|NODE_|NAPI_RS_|PYTHON|GIT_|NPM_|BASH_FUNC_)/.test(upper)) {
    throw new CliError('invalid_arguments', 'Runtime-control environment variables cannot contain vault values.');
  }
  return { name, id, field };
}

export function validateProgram(program) {
  if (!program.length || !program[0] || program.some(value => typeof value !== 'string' || value.includes('\0')) || /\.(cmd|bat)$/i.test(program[0])) {
    throw new CliError('invalid_arguments', 'Provide an executable after --. Windows .cmd/.bat files are not supported; run the underlying executable directly.');
  }
}

export async function runChild(program, env, signal) {
  validateProgram(program);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program[0], program.slice(1), { env, shell: false, stdio: 'inherit' });
    let failure, timer, cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      child.kill('SIGTERM');
      timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', () => { failure = new CliError('command_failed', 'Could not start the requested executable.'); });
    // Wait for actual termination; AbortSignal's spawn error alone does not
    // guarantee that a child holding secrets has stopped.
    child.once('close', (code, stopped) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (cancelled) reject(new DOMException('Cancelled', 'AbortError'));
      else if (failure) reject(failure);
      else resolve(code ?? (stopped === 'SIGINT' ? 130 : stopped === 'SIGTERM' ? 143 : 1));
    });
    if (signal?.aborted) cancel();
  });
}
