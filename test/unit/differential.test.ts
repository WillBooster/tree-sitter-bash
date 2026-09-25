import { afterAll, expect, test } from 'bun:test';

import fs from 'node:fs';
import path from 'node:path';

import { AddonPath, Oracle } from '../helpers/differential/compare.js';
import { generateScript } from '../helpers/differential/generate.js';

// Generated scripts are run by bash (mise.toml pins it) and parsed by the grammar; every command bash
// runs must appear in the tree with the same words, and no other. DIFFERENTIAL_SEED and
// DIFFERENTIAL_CASES explore further locally.
const FirstSeed = Number(process.env.DIFFERENTIAL_SEED ?? 1);
const Cases = Number(process.env.DIFFERENTIAL_CASES ?? 2000);
const MaxReportedMismatches = 5;

// `$BASH` is the executable itself: a version manager's shim would pick another bash in the scripts'
// temporary directory.
const bash = Bun.spawnSync(['bash', '-c', 'echo "$BASH"']).stdout.toString().trim();
const oracle = new Oracle(bash);
afterAll(() => oracle.dispose());

test('uses the Node.js addon built from the current parser', () => {
  const addon = fs.statSync(AddonPath).mtimeMs;
  const sources = ['parser.c', 'scanner.c'].map((name) => fs.statSync(path.join(import.meta.dir, '../../src', name)).mtimeMs);
  expect(Math.max(...sources), 'src/ changed after the addon was built; run `bunx node-gyp rebuild`').toBeLessThanOrEqual(addon);
});

test('uses bash 5.2 or later as the oracle', () => {
  const version = Bun.spawnSync([bash, '-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"']).stdout.toString().trim();
  expect(Number.parseFloat(version), `${bash} is bash ${version}; run \`mise install\``).toBeGreaterThanOrEqual(5.2);
});

test('parses generated scripts into the commands bash runs', () => {
  const mismatches: string[] = [];
  let invalid = 0;
  for (let seed = FirstSeed; seed < FirstSeed + Cases && mismatches.length < MaxReportedMismatches; seed++) {
    const script = generateScript(seed);
    const outcome = oracle.compare(script);
    if (outcome.kind === 'invalid') invalid++;
    if (outcome.kind === 'mismatch') {
      mismatches.push(
        `seed ${seed}:\n${JSON.stringify(script)}\n${outcome.details.join('\n')}\nbash stderr: ${outcome.stderr}\n${outcome.tree}`
      );
    }
  }
  expect(mismatches.join('\n\n')).toBe('');
  // The generator writes valid bash; many rejected scripts would mean it no longer tests anything.
  expect(invalid).toBeLessThan(Cases / 20);
}, 600_000);
