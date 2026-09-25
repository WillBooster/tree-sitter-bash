import { afterAll, expect, test } from 'bun:test';
import assert from 'node:assert';

import { isAddonStale, Oracle } from '../helpers/differential/compare.js';
import { generateScript } from '../helpers/differential/generate.js';

// Generated scripts are run by bash (mise.toml pins it) and parsed by the grammar; every command bash
// runs must appear in the tree with as many words and the same value for each word without
// expansions, no other command may, and a script bash accepts must parse without ERROR or MISSING
// nodes. DIFFERENTIAL_SEED and DIFFERENTIAL_CASES explore further locally.
const FirstSeed = Number(process.env.DIFFERENTIAL_SEED ?? 1);
const Cases = Number(process.env.DIFFERENTIAL_CASES ?? 2000);
// An unparsable value (`10_000`) would otherwise run no script and pass.
assert(
  Number.isSafeInteger(FirstSeed) && Number.isSafeInteger(Cases) && Cases > 0,
  'DIFFERENTIAL_SEED and DIFFERENTIAL_CASES must be integers, and DIFFERENTIAL_CASES positive'
);
const MaxReportedMismatches = 5;

// `$BASH` is the executable itself: a version manager's shim would pick another bash in the scripts'
// temporary directory.
const bash = Bun.spawnSync(['bash', '-c', 'echo "$BASH"']).stdout.toString().trim();
const oracle = new Oracle(bash);
afterAll(() => oracle.dispose());

test('uses a Node.js addon built from the current parser', () => {
  expect(isAddonStale(), 'grammar.js or src/ changed after the addon was built; run `bun run build/ci`').toBe(false);
});

test('uses bash 5.2 or later as the oracle', () => {
  const version = Bun.spawnSync([bash, '-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'])
    .stdout.toString()
    .trim();
  expect(Number.parseFloat(version), `${bash} is bash ${version}; run \`mise install\``).toBeGreaterThanOrEqual(5.2);
});

test('parses generated scripts into the commands bash runs', () => {
  const mismatches: string[] = [];
  let invalid = 0;
  const invalidReasons: string[] = [];
  let runs = 0;
  for (let seed = FirstSeed; seed < FirstSeed + Cases && mismatches.length < MaxReportedMismatches; seed++) {
    runs++;
    const script = generateScript(seed);
    const outcome = oracle.compare(script);
    if (outcome.kind === 'invalid') {
      invalid++;
      if (invalidReasons.length < 3) invalidReasons.push(`seed ${seed}: ${outcome.reason.trim()}`);
    }
    if (outcome.kind === 'mismatch') {
      mismatches.push(
        [`seed ${seed}:`, JSON.stringify(script), ...outcome.details, `bash stderr: ${outcome.stderr}`, outcome.tree].join(
          '\n'
        )
      );
    }
  }
  expect(mismatches.join('\n\n')).toBe('');
  // The generator writes valid bash; many rejected scripts would mean it no longer tests anything. A
  // few hundred scripts are needed for the rate to mean anything.
  if (runs >= 200) {
    const message = `bash rejected ${invalid} of ${runs} scripts:\n${invalidReasons.join('\n')}`;
    expect(invalid, message).toBeLessThan(runs / 20);
  }
}, 600_000);
