import { spawn } from 'node:child_process';

/** Optional power service. Failure is diagnostic only, never worker termination evidence. */
export function keepAwake(warn: (message: string) => void): () => void {
  const command = process.platform === 'darwin' ? '/usr/bin/caffeinate' : process.platform === 'linux' ? 'systemd-inhibit' : null;
  if (!command) { warn('Keep-awake helper is unsupported on this platform; execution continues.'); return () => {}; }
  const args = process.platform === 'darwin' ? ['-i', '-w', String(process.pid)]
    : ['--what=sleep', '--mode=block', '--why=Docket supervisor', '--no-ask-password', 'sleep', 'infinity'];
  let closing = false;
  try {
    const child = spawn(command, args, { stdio: 'ignore', shell: false, windowsHide: true });
    child.once('error', () => warn('Keep-awake helper failed; execution continues.'));
    child.once('exit', () => { if (!closing) warn('Keep-awake helper exited; execution continues.'); });
    return () => { closing = true; child.kill(); };
  } catch { warn('Keep-awake helper failed; execution continues.'); return () => {}; }
}
