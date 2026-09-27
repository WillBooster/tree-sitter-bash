import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

// Leaves time to kill the command and report its output before bun's own test timeout.
const KillMargin = 10_000;

// Tests that a command run from the repository root exits zero within the timeout, and passes its output to
// `check`. The command runs in its own process group, which the timeout kills as a whole: a scanner stuck in
// a loop keeps busy the native binary that `bun run tree-sitter` starts through Node.js, not the direct child.
export function testCommand(
  name: string,
  command: string[],
  timeout: number,
  options: { env?: Record<string, string>; check?: (output: string) => void } = {}
): void {
  test(
    name,
    async () => {
      const child = spawn(command[0], command.slice(1), {
        cwd: `${import.meta.dir}/../..`,
        detached: true,
        env: { ...options.env, ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      const timer = setTimeout(() => process.kill(-child.pid!, 'SIGKILL'), timeout);
      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      clearTimeout(timer);
      expect(exitCode, output).toBe(0);
      options.check?.(output);
    },
    timeout + KillMargin
  );
}
