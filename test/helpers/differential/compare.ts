import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Language, type Node, Parser, type Tree } from '@willbooster/web-tree-sitter';

const Root = path.join(import.meta.dirname, '../../..');
// The Wasm build is the one the package ships.
const WasmPath = path.join(Root, 'tree-sitter-bash.wasm');

// Rebuilding here would race with other test files loading the Wasm build, so a stale one is reported.
export function isWasmStale(): boolean {
  // src/parser.c is generated from grammar.js, so an edit to the grammar alone also makes the Wasm build stale.
  const sources = ['grammar.js', 'src/parser.c', 'src/scanner.c'].map(
    (name) => fs.statSync(path.join(Root, name)).mtimeMs
  );
  return Math.max(...sources) > fs.statSync(WasmPath).mtimeMs;
}

// Waiting on a cell that nothing notifies is Node.js's synchronous sleep.
const SleepCell = new Int32Array(new SharedArrayBuffer(4));

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(WasmPath));

// The tree lives in the Wasm heap, so the caller must `delete()` it.
export function parse(script: string): Tree {
  const tree = parser.parse(script);
  if (!tree) throw new Error('The parser returned no tree');
  return tree;
}

// Each run of `c` writes its words to a file of its own in $C_LOG: appending to one file could
// interleave concurrent runs, since printf may split its output at a newline.
const Prelude = `c() { C_RUNS=$((C_RUNS + 1)); printf '%s\\x1f' "$@" > "$C_LOG/$BASHPID.$C_RUNS"; }
trap wait EXIT
`;

export interface Invocation {
  // The words the command receives; `undefined` marks a word the tree cannot know statically.
  words: (string | undefined)[];
}

export type Outcome =
  | { kind: 'invalid'; reason: string }
  | { kind: 'match' }
  | { kind: 'mismatch'; details: string[]; stderr: string; tree: string };

export class Oracle {
  private readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-sitter-bash-differential-'));
  private readonly preludePath = path.join(this.directory, 'prelude.sh');
  // Each script gets its own paths, so a leftover background process cannot write into a later log.
  private runs = 0;

  constructor(private readonly bash: string) {
    fs.writeFileSync(this.preludePath, Prelude);
  }

  dispose(): void {
    fs.rmSync(this.directory, { force: true, recursive: true });
  }

  compare(script: string): Outcome {
    this.runs++;
    const scriptPath = path.join(this.directory, `script${this.runs}.sh`);
    const logPath = path.join(this.directory, `log${this.runs}`);
    try {
      return this.compareAt(script, scriptPath, logPath);
    } finally {
      // Removed per run, so cleanup time does not grow with the number of scripts.
      fs.rmSync(scriptPath, { force: true });
      fs.rmSync(logPath, { force: true, maxRetries: 3, recursive: true });
    }
  }

  private compareAt(script: string, scriptPath: string, logPath: string): Outcome {
    fs.writeFileSync(scriptPath, script);
    const syntax = spawnSync(this.bash, ['-n', scriptPath], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    if (syntax.status !== 0) return { kind: 'invalid', reason: syntax.stderr };

    fs.mkdirSync(logPath);
    const run = spawnSync(this.bash, ['--norc', '--noprofile', scriptPath], {
      cwd: this.directory,
      encoding: 'utf8',
      env: { BASH_ENV: this.preludePath, C_LOG: logPath, PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10_000,
    });
    // `wait` covers jobs but not process substitutions, which may still be running `c`. Subshells are
    // forks that keep the script path in their arguments.
    const deadline = Date.now() + 10_000;
    while (spawnSync('pgrep', ['-f', scriptPath]).status === 0) {
      if (run.status === null || Date.now() > deadline) {
        spawnSync('pkill', ['-f', scriptPath]);
        return { kind: 'invalid', reason: 'bash timed out' };
      }
      Atomics.wait(SleepCell, 0, 0, 10);
    }
    if (run.status === null) return { kind: 'invalid', reason: 'bash timed out' };
    // Any error means that some command did not run as generated; `bash -n` also skips the bodies of
    // command substitutions, whose syntax errors show up only here. `time` reports, warnings about
    // heredocs that reach the end of input, and the unterminated quote of a generated `"`: '`"` are
    // expected.
    const { stderr } = run;
    const lines = stderr.split('\n').filter((line) => line && !/^(real|user|sys)\s|warning: here-document/u.test(line));
    // Each generated quote cut short by a backquote runs once and reports once; any other report means
    // that a substitution body bash could not parse did not run.
    const cutShortQuotes = script.split(/"`: '`"|"`'`"/u).length - 1;
    const unterminated = lines.filter((line) => line.endsWith("looking for matching `''")).length;
    if (lines.length > unterminated || unterminated > cutShortQuotes) return { kind: 'invalid', reason: stderr };
    const executed = readInvocations(logPath);

    const tree = parse(script);
    try {
      const details: string[] = [];
      if (tree.rootNode.hasError)
        details.push('the tree has ERROR or MISSING nodes although bash -n accepts the script');
      details.push(...diffInvocations(executed, collectInvocations(tree.rootNode)));
      if (details.length === 0) return { kind: 'match' };
      return { kind: 'mismatch', details, stderr, tree: tree.rootNode.toString() };
    } finally {
      tree.delete();
    }
  }
}

// Every run of `c`, grouped by its first word; each id runs once in a generated script.
function readInvocations(directory: string): Map<string, string[][]> {
  const invocations = new Map<string, string[][]>();
  for (const name of fs.readdirSync(directory)) {
    const words = fs.readFileSync(path.join(directory, name), 'utf8').split('\u001F').slice(0, -1);
    const id = words[0] ?? '';
    invocations.set(id, [...(invocations.get(id) ?? []), words]);
  }
  return invocations;
}

// Every `c` command in the tree, grouped by its first word, wherever it is: substitutions, heredoc
// bodies, and function bodies included.
function collectInvocations(root: Node): Map<string, Invocation[]> {
  const invocations = new Map<string, Invocation[]>();
  const visit = (node: Node): void => {
    const name = node.type === 'command' ? node.childForFieldName('name')?.firstChild : undefined;
    if (name && literalValue(name) === 'c') {
      const words = node.childrenForFieldName('argument').map((argument) => literalValue(argument));
      const id = words[0] ?? '';
      invocations.set(id, [...(invocations.get(id) ?? []), { words }]);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return invocations;
}

function diffInvocations(executed: Map<string, string[][]>, parsed: Map<string, Invocation[]>): string[] {
  const details: string[] = [];
  for (const [id, runs] of executed) {
    const invocations = parsed.get(id) ?? [];
    const [words = []] = runs;
    const [invocation] = invocations;
    if (runs.length > 1) details.push(`bash runs \`c ${id}\` ${runs.length} times`);
    if (invocations.length > 1) details.push(`the tree shows \`c ${id}\` ${invocations.length} times`);
    if (!invocation) {
      details.push(`bash runs \`c ${id}\`, which the tree does not show as a command`);
    } else if (
      invocation.words.length !== words.length ||
      invocation.words.some((word, index) => word !== undefined && word !== words[index])
    ) {
      details.push(
        `\`c ${id}\` receives ${JSON.stringify(words)} in bash but ${JSON.stringify(invocation.words)} in the tree`
      );
    }
  }
  for (const [id, invocations] of parsed) {
    if (executed.has(id)) continue;
    details.push(`the tree shows \`c ${id}\` as a command, which bash never runs`);
    if (invocations.length > 1) details.push(`the tree shows \`c ${id}\` ${invocations.length} times`);
  }
  return details;
}

// The word after quote removal when it holds no expansion; `undefined` otherwise.
function literalValue(node: Node): string | undefined {
  switch (node.type) {
    case 'word': {
      return node.text.replaceAll(/\\([\s\S])/gu, (_, next: string) => (next === '\n' ? '' : next));
    }
    // Split into `string_content` children where bash removes line continuations inside the quotes. A heredoc
    // body inside the quotes is read before the line after it, and is no part of the word.
    case 'raw_string': {
      return node.namedChildCount > 0 ? quotedText(node) : node.text.slice(1, -1);
    }
    case 'string': {
      const parts = new Set(['string_content', 'heredoc_body']);
      if (node.namedChildren.some((child) => !parts.has(child.type))) return undefined;
      return quotedText(node).replaceAll(/\\([$`"\\\n])/gu, (_, next: string) => (next === '\n' ? '' : next));
    }
    case 'ansi_c_string': {
      return decodeAnsiC(node.namedChildCount > 0 ? quotedText(node) : node.text.slice(2, -1));
    }
    // A deferred heredoc body may split a word where bash removes a line continuation.
    case 'concatenation': {
      const parts = node.children.filter((child) => child.type !== 'heredoc_body').map((child) => literalValue(child));
      return parts.includes(undefined) ? undefined : parts.join('');
    }
    default: {
      return undefined;
    }
  }
}

function quotedText(node: Node): string {
  return node.namedChildren
    .filter((child) => child.type === 'string_content')
    .map((child) => child.text)
    .join('');
}

function decodeAnsiC(text: string): string {
  return text.replaceAll(/\\(x[0-9a-fA-F]{1,2}|[\s\S])/gu, (_, escape: string) => {
    if (escape.startsWith('x') && escape.length > 1) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    return AnsiCEscapes[escape] ?? `\\${escape}`;
  });
}

const AnsiCEscapes: Record<string, string> = {
  "'": "'",
  '"': '"',
  '?': '?',
  '\\': '\\',
  a: '\u0007',
  b: '\b',
  e: '\u001B',
  E: '\u001B',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};
