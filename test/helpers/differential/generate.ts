import { Random } from './random.js';

// Generates bash scripts whose only commands are `c <id> <args…>`, a logging function the oracle
// defines, and in which every such command runs exactly once. Comparing the commands bash runs with
// the commands the syntax tree shows then checks where the parser draws the line between code and
// data (heredoc bodies, quotes, comments, substitutions) and how it splits words. Text that looks
// like a command uses `d` ids; whether one runs (a substitution in an unquoted heredoc body) or not
// (quotes, comments, quoted heredoc bodies) is left to bash.
export function generateScript(seed: number): string {
  return new ScriptGenerator(seed).script();
}

const MaxDepth = 3;

class ScriptGenerator {
  private readonly random: Random;
  private output = '';
  // Heredoc bodies wait for the next newline at their substitution depth, as bash reads them.
  private readonly pendingHeredocs: string[][] = [[]];
  private nextCommandId = 0;
  private nextDataId = 0;
  private nextFunctionId = 0;
  // Inside backquotes, heredocs and newlines are avoided: their bodies would need nested quoting.
  private inBackquotes = false;
  private heredocsDisabled = 0;
  private substitutionsDisabled = 0;

  constructor(seed: number) {
    this.random = new Random(seed);
  }

  script(): string {
    const count = 1 + this.random.int(5);
    for (let index = 0; index < count; index++) {
      this.statement(0);
      this.terminator();
    }
    this.newline();
    return this.output;
  }

  private emit(text: string): void {
    this.output += text;
  }

  private newline(): void {
    this.emit('\n');
    const pending = this.pendingHeredocs.at(-1) ?? [];
    for (const body of pending.splice(0)) this.emit(body);
  }

  // Separates or ends a statement; a newline also starts the bodies of pending heredocs.
  private terminator(): void {
    switch (this.random.int(5)) {
      case 0: {
        this.emit(';');
        this.newline();
        break;
      }
      case 1: {
        this.emit(' &');
        this.newline();
        break;
      }
      case 2: {
        this.emit(this.random.pick(['; ', ' & ']));
        break;
      }
      case 3: {
        // A comment ends at the newline even after a backslash.
        this.emit(' # ');
        this.emit(this.dataText());
        if (this.random.chance(0.3)) this.emit(' \\');
        this.newline();
        break;
      }
      default: {
        this.newline();
      }
    }
  }

  // A space between words, sometimes a tab or continued onto the next line.
  private space(): void {
    if (this.random.chance(0.08) && !this.inBackquotes) this.emit(' \\\n');
    else this.emit(this.random.pick([' ', ' ', ' ', '\t', '  ']));
  }

  // After `|`, `&&`, and `||`, a newline continues the list, and heredoc bodies start after it.
  private operatorSpace(): void {
    if (this.newlineAllowed() && this.random.chance(0.15)) this.newline();
    else this.space();
  }

  private commandId(): string {
    return `k${this.nextCommandId++}`;
  }

  // Looks like a command for a reader who mistakes data for code; bash decides whether it runs.
  private dataText(): string {
    const id = `d${this.nextDataId++}`;
    return this.random.pick([`c ${id}`, `c ${id}; c ${id}x`, `$(c ${id})`, `\`c ${id}\``, `c ${id} | c ${id}y`]);
  }

  private statement(depth: number): void {
    const kinds = depth >= MaxDepth ? ['simple'] : StatementKinds;
    switch (this.random.pick(kinds)) {
      case 'pipeline': {
        this.simpleCommand(depth);
        this.emit(this.random.pick([' |', ' |&', '|']));
        this.operatorSpace();
        this.simpleCommand(depth);
        break;
      }
      case 'and': {
        this.simpleCommand(depth);
        this.emit(' &&');
        this.operatorSpace();
        this.statement(depth + 1);
        break;
      }
      case 'or': {
        // `!` makes the left side fail, so the right side runs.
        this.emit('! ');
        this.simpleCommand(depth);
        this.emit(' ||');
        this.operatorSpace();
        this.statement(depth + 1);
        break;
      }
      case 'subshell': {
        this.emit('( ');
        this.list(depth + 1);
        this.emit(' )');
        break;
      }
      case 'group': {
        this.emit('{ ');
        this.list(depth + 1);
        this.emit('; }');
        break;
      }
      case 'if': {
        this.emit('if ');
        this.simpleCommand(depth);
        this.emit('; then ');
        this.list(depth + 1);
        this.emit('; fi');
        break;
      }
      case 'for': {
        this.emit('for v in 1; do ');
        this.list(depth + 1);
        this.emit('; done');
        break;
      }
      case 'while': {
        this.emit('while ');
        this.simpleCommand(depth);
        this.emit('; do ');
        this.list(depth + 1);
        this.emit('; break; done');
        break;
      }
      case 'case': {
        this.emit(this.random.pick(['case a in a) ', 'case a in (a) ', 'case a in b|a) ', 'case "a" in *) ']));
        this.list(depth + 1);
        if (this.newlineAllowed() && this.random.chance(0.3)) {
          this.emit(' ;;');
          this.newline();
          this.emit('esac');
        } else {
          this.emit(this.random.pick([' ;; esac', ';; esac']));
        }
        break;
      }
      case 'function': {
        const name = `f${this.nextFunctionId++}`;
        this.emit(this.random.chance(0.5) ? `${name}() { ` : `function ${name} { `);
        this.list(depth + 1);
        this.emit(`; }; ${name}`);
        break;
      }
      case 'else': {
        // The condition fails, so the else (or elif) branch runs.
        this.emit('if ! ');
        this.simpleCommand(depth);
        if (this.random.chance(0.5)) {
          this.emit('; then :; else ');
        } else {
          this.emit('; then :; elif ');
          this.simpleCommand(depth);
          this.emit('; then ');
        }
        this.list(depth + 1);
        this.emit('; fi');
        break;
      }
      case 'until': {
        this.emit('until ! ');
        this.simpleCommand(depth);
        this.emit('; do ');
        this.list(depth + 1);
        this.emit('; break; done');
        break;
      }
      case 'fallthrough': {
        // `;&` runs the next item's body; `;;&` tests the next pattern, which matches too.
        this.emit('case a in a) ');
        this.list(depth + 1);
        this.emit(this.random.pick([' ;& b) ', ' ;;& a) ']));
        this.list(depth + 1);
        this.emit(' ;; esac');
        break;
      }
      case 'test': {
        this.emit(this.random.pick(['[[ -n x && a == a ]] && ', '(( 1 + 1 )) && ', '[[ -z "y" ]] || ']));
        this.statement(depth + 1);
        break;
      }
      case 'time': {
        this.emit(this.random.pick(['time ', 'time -p ']));
        this.simpleCommand(depth);
        break;
      }
      case 'declaration': {
        // Only the substitution in the value runs.
        this.emit(`${this.random.pick(['export', 'declare', 'readonly', 'W=b'])} V${this.nextFunctionId++}=`);
        const array = this.random.chance(0.3);
        const quoted = this.random.chance(0.5);
        this.emit(`${array ? '(x ' : ''}${quoted ? '"$(' : '$('}`);
        this.substitutionBody(depth);
        this.emit(`${quoted ? ')"' : ')'}${array ? ' y)' : ''}`);
        break;
      }
      default: {
        this.simpleCommand(depth);
      }
    }
  }

  // One or more statements that run in order; used inside compound commands.
  private list(depth: number): void {
    const count = 1 + this.random.int(2);
    for (let index = 0; index < count; index++) {
      if (index > 0) {
        if (!this.newlineAllowed() || this.random.chance(0.6)) this.emit('; ');
        else this.newline();
      }
      this.statement(depth);
    }
  }

  // Bash 5.2 drops a `;` on the line after a heredoc inside a command substitution, so substitutions
  // stay on one line until the bodies of their heredocs, right before the closer.
  private newlineAllowed(): boolean {
    return this.pendingHeredocs.length === 1;
  }

  private simpleCommand(depth: number): void {
    if (this.random.chance(0.15)) this.emit(`V=${this.literalWord()} `);
    this.emit(`c ${this.commandId()}`);
    const argumentCount = this.random.int(4);
    for (let index = 0; index < argumentCount; index++) {
      this.space();
      this.argument(depth);
    }
    const redirectionCount = this.random.int(3);
    for (let index = 0; index < redirectionCount; index++) {
      this.space();
      this.redirection(depth);
    }
  }

  // Every argument yields exactly one word for the command, so argument lists line up.
  private argument(depth: number): void {
    if (this.inBackquotes) {
      // Quotes and backslashes inside backquotes follow extra rules; plain words keep the check simple.
      this.emit(this.random.chance(0.5) ? this.literalWord() : `'c d${this.nextDataId++}'`);
      return;
    }
    const substitutions = depth < MaxDepth && this.substitutionsDisabled === 0;
    switch (this.random.int(substitutions ? 10 : 6)) {
      case 0: {
        this.emit(`'${this.dataText().replaceAll("'", '')}'`);
        break;
      }
      case 1: {
        this.emit(`"${this.escapeDoubleQuoted(this.dataText())}"`);
        break;
      }
      case 2: {
        this.emit(`$'${this.random.pick(['a\\tb', 'x\\x41y', "it\\'s", 'a\\\\b', '\\n'])}'`);
        break;
      }
      case 3: {
        this.emit(
          this.random.pick([
            'a\\ b',
            '\\$x',
            '\\#y',
            'a\\;b',
            '\\"q\\"',
            "\\'",
            'a#b',
            'x=y',
            '--opt=v',
            'ab\\\ncd',
            '"a\\\nb"',
            "'a\\\nb'",
            'a\\\\',
            '"\\\\"',
          ])
        );
        break;
      }
      case 4: {
        this.emit(`${this.literalWord()}"${this.escapeDoubleQuoted(this.dataText())}"'x'`);
        break;
      }
      case 5: {
        if (substitutions && this.random.chance(0.4)) {
          // Both expand, so the substitution runs.
          const [open, close] = this.random.pick([
            ['"${X:-$(', ')}"'],
            ['"$(( $(', ') + 1 ))"'],
          ] as const);
          this.emit(open);
          this.substitutionBody(depth);
          this.emit(close);
          break;
        }
        this.emit(this.random.pick(['"$((1 + 2))"', '"${X:-d}"', '$((3*4))', '"$*"']));
        break;
      }
      case 6: {
        this.emit('"$(');
        this.substitutionBody(depth);
        this.emit(')"');
        break;
      }
      case 7: {
        this.emit(this.random.chance(0.7) ? '<(' : '>(');
        this.substitutionBody(depth);
        this.emit(')');
        break;
      }
      case 8: {
        this.emit('"`');
        this.inBackquotes = true;
        this.statement(MaxDepth);
        this.inBackquotes = false;
        this.emit('`"');
        break;
      }
      default: {
        this.emit(this.literalWord());
      }
    }
  }

  // The body of `$(…)` or `<(…)`: its heredocs end inside it, so a newline precedes the closer when
  // one is pending.
  // Bash 5.2 drops the second and later `;` after a heredoc inside a command substitution, so a
  // substitution holds heredocs only as a lone simple command without nested substitutions.
  private substitutionBody(depth: number): void {
    this.pendingHeredocs.push([]);
    const start = this.output.length;
    if (this.random.chance(0.4)) {
      this.substitutionsDisabled++;
      this.simpleCommand(depth + 1);
      this.substitutionsDisabled--;
    } else {
      this.heredocsDisabled++;
      this.statement(depth + 1);
      this.heredocsDisabled--;
    }
    // `$((` starts an arithmetic expansion unless bash fails to parse one, which the grammar does not model.
    if (this.output[start] === '(') this.output = `${this.output.slice(0, start)} ${this.output.slice(start)}`;
    if ((this.pendingHeredocs.at(-1)?.length ?? 0) > 0) this.newline();
    this.pendingHeredocs.pop();
  }

  private redirection(depth: number): void {
    const canHeredoc = !this.inBackquotes && this.heredocsDisabled === 0;
    switch (this.random.int(canHeredoc ? 4 : 2)) {
      case 0: {
        this.emit(
          this.random.pick([
            '>/dev/null',
            '2>/dev/null',
            '>> /dev/null',
            '2>&1',
            '</dev/null',
            '&>/dev/null',
            '&>> /dev/null',
            '>&2',
            '1>&2',
            '3>/dev/null',
            '>| /dev/null',
            '<> /dev/null',
          ])
        );
        break;
      }
      case 1: {
        if (depth < MaxDepth && this.substitutionsDisabled === 0 && this.random.chance(0.3)) {
          this.emit('<<< "$(');
          this.substitutionBody(depth);
          this.emit(')"');
          break;
        }
        // A backquote ends backquotes even inside single quotes.
        const data = this.dataText().replaceAll(this.inBackquotes ? /['`]/gu : /'/gu, '');
        this.emit(`<<< ${this.random.pick(['word', `'${data}'`, '"x y"'])}`);
        break;
      }
      default: {
        this.heredoc(depth);
      }
    }
  }

  private heredoc(depth: number): void {
    const indent = this.random.chance(0.3);
    const [word, delimiter, quoted] = this.random.pick(HeredocDelimiters);
    this.emit(`${indent ? '<<-' : '<<'}${word}`);
    let body = '';
    const lineCount = this.random.int(4);
    for (let index = 0; index < lineCount; index++) {
      const line = this.heredocLine(delimiter, quoted, indent, depth);
      // A continued last line would join the terminator, leaving the heredoc open to the end of input.
      body += `${index === lineCount - 1 && !quoted ? line.replace(/\\$/u, '') : line}\n`;
    }
    body += `${this.heredocTerminator(delimiter, quoted, indent)}\n`;
    this.pendingHeredocs.at(-1)?.push(body);
  }

  private heredocLine(delimiter: string, quoted: boolean, indent: boolean, depth: number): string {
    const tab = indent && this.random.chance(0.5) ? '\t' : '';
    switch (this.random.int(8)) {
      case 0: {
        // Unquoted, this runs; quoted, it is data. The id is fresh either way and bash decides.
        return `${tab}x $(c ${this.commandId()}) y`;
      }
      case 1: {
        return `${tab}\`c ${this.commandId()}\``;
      }
      case 2: {
        // Looks like the delimiter but is not the whole line.
        return `${tab}${this.random.pick([`${delimiter} `, ` ${delimiter}`, `${delimiter}x`, `x${delimiter}`])}`;
      }
      case 3: {
        // A continued line: unquoted bodies join it with the next line.
        return `${tab}${this.dataText()} \\`;
      }
      case 4: {
        return this.random.chance(0.5) ? `${tab}\\${delimiter}` : `${tab}\\$(c d${this.nextDataId++}) \\\`c d${this.nextDataId++}\\\``;
      }
      case 5: {
        return depth < MaxDepth && !quoted ? `${tab}\${X:-$(c ${this.commandId()})}` : `${tab}$X \\$Y`;
      }
      default: {
        return `${tab}${this.dataText()}`;
      }
    }
  }

  private heredocTerminator(delimiter: string, quoted: boolean, indent: boolean): string {
    const tabs = indent ? this.random.pick(['', '\t', '\t\t']) : '';
    if (!quoted && delimiter.length > 1 && this.random.chance(0.3)) {
      // An unquoted body joins a backslash-newline before comparing a line with the delimiter.
      const split = 1 + this.random.int(delimiter.length - 1);
      return `${tabs}${delimiter.slice(0, split)}\\\n${delimiter.slice(split)}`;
    }
    return `${tabs}${delimiter}`;
  }

  private literalWord(): string {
    return this.random.pick([
      'a',
      'b1',
      'foo.txt',
      '/tmp/x',
      '-n',
      '42',
      'x-y_z',
      '@',
      '%',
      '+',
      'a,b',
      'a:b',
      'ü',
      '日本',
      // Reserved words are plain words after a command's first word.
      'if',
      'then',
      'do',
      'done',
      'fi',
      'esac',
      'in',
      '{',
      '}',
      '!',
      'time',
    ]);
  }

  private escapeDoubleQuoted(text: string): string {
    return text.replaceAll(/[$`"\\]/gu, (character) => `\\${character}`);
  }
}

const StatementKinds = [
  'simple',
  'simple',
  'simple',
  'pipeline',
  'and',
  'or',
  'subshell',
  'group',
  'if',
  'else',
  'for',
  'while',
  'until',
  'case',
  'fallthrough',
  'function',
  'test',
  'time',
  'declaration',
] as const;

// [word as written, delimiter after quote removal, whether any quoting makes the body literal]
const HeredocDelimiters: readonly (readonly [string, string, boolean])[] = [
  ['EOF', 'EOF', false],
  ['END_1', 'END_1', false],
  ['X', 'X', false],
  [' EOF', 'EOF', false],
  ["'EOF'", 'EOF', true],
  ['"EOF"', 'EOF', true],
  ['E"O"F', 'EOF', true],
  ['\\EOF', 'EOF', true],
  ["'E O'", 'E O', true],
];
