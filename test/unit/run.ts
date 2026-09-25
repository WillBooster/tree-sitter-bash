import { expect } from 'bun:test';

// Runs a command from the repository root and fails with its output when it exits non-zero.
export function expectToSucceed(command: string[]): void {
  const result = Bun.spawnSync(command, { cwd: `${import.meta.dir}/../..`, stdout: 'pipe', stderr: 'pipe' });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(0);
}
