import { afterAll, expect, test } from 'vitest';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

import { isWasmStale, Oracle } from '../helpers/differential/compare.js';
import { generateScript } from '../helpers/differential/generate.js';

// Generated scripts are run by bash (mise.toml pins it) and parsed by the grammar; every command bash
// runs must appear in the tree with as many words and the same value for each word without
// expansions, no other command may, and a script bash accepts must parse without ERROR or MISSING
// nodes. DIFFERENTIAL_SEED and DIFFERENTIAL_CASES explore further locally.
const FirstSeed = Number(process.env.DIFFERENTIAL_SEED ?? 1);
const Cases = Number(process.env.DIFFERENTIAL_CASES ?? 2000);
// An unparsable value (`10_000`) would otherwise run no script and pass.
assert.ok(
  Number.isSafeInteger(FirstSeed) && Number.isSafeInteger(Cases) && Cases > 0,
  'DIFFERENTIAL_SEED and DIFFERENTIAL_CASES must be integers, and DIFFERENTIAL_CASES positive'
);
const MaxReportedMismatches = 5;

// `$BASH` is the executable itself: a version manager's shim would pick another bash in the scripts'
// temporary directory.
const bash = spawnSync('bash', ['-c', 'echo "$BASH"'], { encoding: 'utf8' }).stdout.trim();
const oracle = new Oracle(bash);
afterAll(() => oracle.dispose());

test('uses a Wasm build of the current parser', () => {
  expect(isWasmStale(), 'generation inputs or src/ changed after the Wasm build; run `bun run build/ci`').toBe(false);
});

test('uses bash 5.2 or later as the oracle', () => {
  const version = spawnSync(bash, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], {
    encoding: 'utf8',
  }).stdout.trim();
  expect(Number.parseFloat(version), `${bash} is bash ${version}; run \`mise install\``).toBeGreaterThanOrEqual(5.2);
});

test('preserves command and word boundaries after backquote escape removal', () => {
  for (const quoted of [false, true]) {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const suffixes = [' b', '; c second', '| c second', '& c second'];
      if (count % 2 === 0) suffixes.push('');
      for (const suffix of suffixes) {
        const substitution = `x\`c inner a${'\\'.repeat(count)}${suffix}\``;
        const script = `c outer ${quoted ? `"${substitution}"` : substitution}\n`;
        expect(oracle.compare(script), script).toEqual({ kind: 'match' });
      }
    }
  }
});

test('preserves words and expansions across backquote line preprocessing', () => {
  for (const quoted of [false, true]) {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const bodies = [
        `a${'\\'.repeat(count)}\n c second`,
        `a${'\\'.repeat(count)}\nc second`,
        `${'\\'.repeat(count)}\n c second`,
        `"a${'\\'.repeat(count)}\n$(c second)"`,
        `a${'\\'.repeat(count)}\n\nc second`,
        `"a${'\\'.repeat(count)}\n\\$(c second)"`,
      ];
      if (count % 4 !== 0) bodies.push(`a${'\\'.repeat(count)}\n${'\\'.repeat(count)}\n c second`);
      for (const body of bodies) {
        const substitution = `x\`c inner ${body}\``;
        const script = `c outer ${quoted ? `"${substitution}"` : substitution}\n`;
        expect(oracle.compare(script), script).toEqual({ kind: 'match' });
      }
    }
  }
}, 30_000);

test('keeps structured word prefixes separate across disappearing backquote continuations', () => {
  const prefixes = ['"a"', "'a'", 'a$x', 'a${x}', 'a$(c prefix)', '"a$x"', 'a$((1))'];
  for (const quoted of [false, true]) {
    for (const prefix of prefixes) {
      for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const suffixes = [' c second', 'c second', '\tc second'];
        if (count % 4 !== 0) suffixes.push('; c second');
        for (const suffix of suffixes) {
          for (const leading of ['', '\\\n']) {
            const substitution = `x\`c inner ${prefix}${leading}${'\\'.repeat(count)}\n${suffix}\``;
            const script = `c outer ${quoted ? `"${substitution}"` : substitution}\n`;
            expect(oracle.compare(script), script).toEqual({ kind: 'match' });
          }
        }
      }
    }
  }
}, 60_000);

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
        [
          `seed ${seed}:`,
          JSON.stringify(script),
          ...outcome.details,
          `bash stderr: ${outcome.stderr}`,
          outcome.tree,
        ].join('\n')
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
