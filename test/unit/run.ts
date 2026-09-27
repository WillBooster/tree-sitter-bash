import { expect } from 'bun:test';

// Runs a command from the repository root and fails with its output when it exits non-zero. The timeout
// also stops a scanner stuck in a loop, which the CLI's parse timeout cannot interrupt.
export function expectToSucceed(command: string[], timeout: number, env?: Record<string, string>): string {
  const result = Bun.spawnSync(command, {
    cwd: `${import.meta.dir}/../..`,
    env: env && { ...env, ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(0);
  return output;
}
