/**
 * @file Bash grammar for tree-sitter
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Characters that end an unquoted word part: metacharacters, quotes, and characters that begin an
// expansion. `#` only starts a comment at the beginning of a word, so it is handled separately.
const WORD_BREAKS = ['\\s', '|', '&', ';', '(', ')', '<', '>', '"', '\'', '`', '$', '\\\\'];

// Extglob groups nest (`@(a|+([0-9]))`); a regular expression expresses a fixed depth, and three levels
// cover every nested pattern in the example corpora.
// The depth must match EXTGLOB_LITERAL_DEPTH in src/scanner.c.
const EXTGLOB_GROUP = extglobGroup('[?*+@]', 3);
const EXTGLOB_NEGATION = extglobGroup('!', 3);

// Text inside `${…}` and subscripts stops before `<(`/`>(`, so a process substitution there is parsed.
const SUBSCRIPT_TEXT = /([^\[\]$`"'\\<>]|[<>]+[^(\[\]$`"'\\<>]|\\.)+/;

const PREC = {
  COMMA: -1,
  ASSIGN: 1,
  TERNARY: 2,
  LOGICAL_OR: 3,
  LOGICAL_AND: 4,
  BITWISE_OR: 5,
  BITWISE_XOR: 6,
  BITWISE_AND: 7,
  EQUALITY: 8,
  COMPARE: 9,
  SHIFT: 10,
  ADD: 11,
  MULTIPLY: 12,
  EXPONENT: 13,
  UNARY: 14,
  PREFIX: 15,
  POSTFIX: 16,
};

const TEST_UNARY_OPERATORS = [
  '-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-w', '-x',
  '-G', '-L', '-N', '-O', '-S', '-z', '-n', '-o', '-v', '-R',
];
const TEST_BINARY_OPERATORS = [
  '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef', '==', '=', '!=', '<', '>',
];

module.exports = grammar({
  name: 'bash',

  externals: $ => [
    $.heredoc_start,
    $._heredoc_body_start,
    $.heredoc_content,
    $.heredoc_end,
    $._heredoc_arrow,
    $._heredoc_arrow_dash,
    $._concat,
    $.file_descriptor,
    $.variable_name,
    $._bare_dollar,
    $._empty_value,
    $.regex,
    $.string_content,
    $._backtick_open,
    $._backtick_close,
    $._newline,
    $._substitution_start,
    $._substitution_end,
    $._brace_substitution_end,
    $._bracket_substitution_end,
    $._extglob_prefix,
    $._line_continuation,
    $._brace_substitution_start,
    $._bracket_substitution_start,
    $.__error_recovery,
  ],

  extras: $ => [
    $.comment,
    $.heredoc_body,
    /\s/,
    /\\\r?\n/,
    $._line_continuation,
  ],

  supertypes: $ => [
    $._statement,
    $._arithmetic_expression,
  ],

  inline: $ => [
    $._terminator,
    $._command_statement,
  ],

  // Until `;;` or `esac`, a case item's statements may belong to a middle item or to the last one.
  conflicts: $ => [
    [$._statements, $._last_case_item],
  ],

  word: $ => $.word,

  rules: {
    program: $ => optional($._statements),

    // Statements

    _statements: $ => seq(
      repeat(seq($._statement, $._terminator)),
      $._statement,
      optional($._terminator),
    ),

    _terminated_statements: $ => repeat1(seq($._statement, $._terminator)),

    // A newline is significant only where it can end a statement; elsewhere it is whitespace.
    _terminator: $ => choice(';', '&', $._newline),

    _statement: $ => choice(
      $._command_statement,
      $.pipeline,
      $.list,
      $.negated_command,
      $.timed_command,
      $.coproc_command,
    ),

    _command_statement: $ => choice(
      $.command,
      $.declaration_command,
      $.redirected_statement,
      $._compound_command,
      $.function_definition,
    ),

    _compound_command: $ => choice(
      $.compound_statement,
      $.subshell,
      $.arithmetic_command,
      $.test_command,
      $.if_statement,
      $.while_statement,
      $.for_statement,
      $.c_style_for_statement,
      $.case_statement,
    ),

    list: $ => prec.left(1, seq(
      field('left', $._statement),
      field('operator', choice('&&', '||')),
      field('right', $._statement),
    )),

    pipeline: $ => prec.left(3, seq(
      $._pipeline_element,
      repeat1(seq(choice('|', '|&'), $._pipeline_element)),
    )),

    _pipeline_element: $ => choice($._command_statement, $.coproc_command),

    negated_command: $ => prec.right(2, seq('!', choice($._command_statement, $.pipeline, $.timed_command))),

    timed_command: $ => prec.right(2, seq(
      'time',
      optional(field('option', alias('-p', $.word))),
      optional(choice($._command_statement, $.pipeline, $.negated_command)),
    )),

    coproc_command: $ => prec.right(seq(
      'coproc',
      choice(
        $.command,
        // Like bash (`coproc [NAME] command [redirections]`), a compound body takes redirections.
        seq(
          optional(field('name', $.word)),
          $._compound_command,
          repeat(field('redirect', $._redirect)),
        ),
      ),
    )),

    redirected_statement: $ => prec.left(seq(
      field('body', choice($._compound_command, $.function_definition)),
      repeat1(field('redirect', $._redirect)),
    )),

    // Simple commands

    command: $ => prec.left(choice(
      seq(
        repeat($._command_prefix),
        field('name', $.command_name),
        repeat(choice(field('argument', $._argument), field('redirect', $._redirect))),
      ),
      repeat1($._command_prefix),
    )),

    _command_prefix: $ => choice(field('assignment', $.variable_assignment), field('redirect', $._redirect)),

    command_name: $ => $._word,

    declaration_command: $ => prec.left(seq(
      repeat($._command_prefix),
      field('name', alias(choice('declare', 'typeset', 'export', 'readonly', 'local'), $.command_name)),
      repeat(choice(
        field('argument', choice($.variable_assignment, $._argument)),
        field('redirect', $._redirect),
      )),
    )),

    variable_assignment: $ => seq(
      field('name', choice($.variable_name, $.subscript)),
      field('operator', token.immediate(choice('=', '+='))),
      field('value', choice($._argument, $._hash_value, $.array, $._empty_value)),
    ),

    // A value is not at the start of a word, so a leading `#` is literal (`color=#fff`).
    _hash_value: $ => choice(alias($._hash_word, $.word), alias($._hash_concatenation, $.concatenation)),

    _hash_concatenation: $ => prec.right(seq(
      alias($._hash_word, $.word),
      repeat1(seq($._concat, choice(
        $._word_part,
        alias($._hash_word, $.word),
        alias($._negated_extglob_pattern, $.extglob_pattern),
      ))),
    )),

    subscript: $ => seq(
      field('name', $.variable_name),
      token.immediate('['),
      field('index', $._subscript_index),
      ']',
    ),

    // Like bash, the index extends to the matching `]`, so it may hold bracketed groups at any depth
    // (`A[x[1[2]]]`), blanks, and newlines.
    _subscript_index: $ => repeat1(choice(
      alias(token.immediate(prec(1, SUBSCRIPT_TEXT)), $.word),
      alias(token(prec(1, SUBSCRIPT_TEXT)), $.word),
      alias($._angle_text, $.word),
      $._quoted_or_expansion,
      $._subscript_group,
    )),

    _subscript_group: $ => seq('[', optional($._subscript_index), ']'),

    // Word parts that carry their own delimiters, usable where a bare word would overrun a closing
    // `]` or `}`.
    _quoted_or_expansion: $ => choice(
      $.string,
      $.raw_string,
      $.ansi_c_string,
      $.translated_string,
      $.simple_expansion,
      $.expansion,
      $.command_substitution,
      $.arithmetic_expansion,
      $.process_substitution,
    ),

    array: $ => seq(
      token.immediate('('),
      repeat($._argument),
      ')',
    ),

    // Redirections

    _redirect: $ => choice($.file_redirect, $.heredoc_redirect, $.herestring_redirect),

    file_redirect: $ => seq(
      optional(field('descriptor', $.file_descriptor)),
      choice(
        seq(
          field('operator', choice('<', '>', '>>', '>|', '<>', '&>', '&>>', '<&', '>&')),
          field('destination', $._argument),
        ),
        field('operator', choice('<&-', '>&-')),
      ),
    ),

    herestring_redirect: $ => seq(
      optional(field('descriptor', $.file_descriptor)),
      field('operator', '<<<'),
      field('value', $._argument),
    ),

    heredoc_redirect: $ => seq(
      optional(field('descriptor', $.file_descriptor)),
      field('operator', choice(alias($._heredoc_arrow, '<<'), alias($._heredoc_arrow_dash, '<<-'))),
      field('delimiter', $.heredoc_start),
    ),

    // The scanner opens a body at the newline that ends the line holding its `<<` operator, so bodies
    // appear, in operator order, wherever that newline falls.
    heredoc_body: $ => seq(
      $._heredoc_body_start,
      repeat(choice(
        $.heredoc_content,
        $.simple_expansion,
        $.expansion,
        $.command_substitution,
        $.arithmetic_expansion,
      )),
      $.heredoc_end,
    ),

    // Compound commands

    compound_statement: $ => seq('{', optional($._terminated_statements), '}'),

    subshell: $ => seq('(', optional($._statements), ')'),

    arithmetic_command: $ => seq(
      '((',
      $._substitution_start,
      optional($._arithmetic_expression),
      $._substitution_end,
      '))',
    ),

    test_command: $ => seq('[[', $._test_expression, ']]'),

    _test_expression: $ => choice(
      $._word,
      $.unary_test,
      $.binary_test,
      $.regex_test,
      alias($._test_negation, $.negated_test),
      alias($._test_logical, $.logical_test),
      alias($._test_parenthesized, $.parenthesized_test),
    ),

    unary_test: $ => prec(PREC.UNARY, seq(
      field('operator', alias(choice(...TEST_UNARY_OPERATORS), $.test_operator)),
      field('operand', $._argument),
    )),

    // The right side of `==`/`!=` is a pattern matched as if extglob were enabled.
    binary_test: $ => prec(PREC.COMPARE, seq(
      field('left', $._word),
      field('operator', alias(choice(...TEST_BINARY_OPERATORS), $.test_operator)),
      field('right', $._argument),
    )),

    regex_test: $ => prec(PREC.COMPARE, seq(
      field('left', $._word),
      field('operator', '=~'),
      field('right', $.regex),
    )),

    _test_negation: $ => prec(PREC.UNARY, seq('!', $._test_expression)),

    _test_logical: $ => choice(
      prec.left(PREC.LOGICAL_AND, seq($._test_expression, '&&', $._test_expression)),
      prec.left(PREC.LOGICAL_OR, seq($._test_expression, '||', $._test_expression)),
    ),

    _test_parenthesized: $ => seq('(', $._test_expression, ')'),

    if_statement: $ => seq(
      'if',
      field('condition', $._terminated_statements),
      'then',
      optional(field('consequence', $._terminated_statements)),
      repeat($.elif_clause),
      optional($.else_clause),
      'fi',
    ),

    elif_clause: $ => seq(
      'elif',
      field('condition', $._terminated_statements),
      'then',
      optional(field('consequence', $._terminated_statements)),
    ),

    else_clause: $ => seq('else', optional($._terminated_statements)),

    while_statement: $ => seq(
      field('keyword', choice('while', 'until')),
      field('condition', $._terminated_statements),
      field('body', $.do_group),
    ),

    do_group: $ => seq('do', optional($._terminated_statements), 'done'),

    for_statement: $ => seq(
      field('keyword', choice('for', 'select')),
      field('variable', alias($.word, $.variable_name)),
      // Without a word list the separator is optional (`for i do …`); a newline may precede `in`.
      choice(
        seq(optional($._newline), 'in', repeat(field('value', $._argument)), $._terminator),
        optional($._terminator),
      ),
      field('body', choice($.do_group, $.compound_statement)),
    ),

    c_style_for_statement: $ => seq(
      'for',
      '((',
      $._substitution_start,
      field('initializer', optional($._arithmetic_expression)),
      ';',
      field('condition', optional($._arithmetic_expression)),
      ';',
      field('update', optional($._arithmetic_expression)),
      $._substitution_end,
      '))',
      optional($._terminator),
      field('body', choice($.do_group, $.compound_statement)),
    ),

    case_statement: $ => seq(
      'case',
      field('value', $._argument),
      'in',
      repeat($.case_item),
      optional(alias($._last_case_item, $.case_item)),
      'esac',
    ),

    case_item: $ => seq(
      $._case_patterns,
      optional($._statements),
      field('terminator', choice(';;', ';&', ';;&')),
    ),

    // Only the last item may omit its terminator, but its statements still end before `esac`, which is
    // otherwise an argument (`a) echo esac`).
    _last_case_item: $ => seq($._case_patterns, optional($._terminated_statements)),

    _case_patterns: $ => seq(
      optional('('),
      field('pattern', $._argument),
      repeat(seq('|', field('pattern', $._argument))),
      ')',
    ),

    function_definition: $ => seq(
      choice(
        seq('function', field('name', $.word), optional(seq('(', ')'))),
        seq(field('name', $.word), '(', ')'),
      ),
      field('body', $._compound_command),
    ),

    // Words

    _word: $ => choice($._word_part, $.concatenation),

    // Outside command position a leading `!(` is a negated extglob group rather than `!` negating a
    // subshell.
    _argument: $ => choice(
      $._word,
      alias($._negated_extglob_word, $.word),
      alias($._negated_extglob_pattern, $.extglob_pattern),
      alias($._negated_extglob_concatenation, $.concatenation),
    ),

    // A word led by a negated group (`!($x)b`, `!(a)$x`).
    _negated_extglob_concatenation: $ => prec.right(seq(
      choice(alias($._negated_extglob_pattern, $.extglob_pattern), alias($._negated_extglob_word, $.word)),
      repeat1(seq($._concat, choice(
        $._word_part,
        alias($._hash_word, $.word),
        alias($._negated_extglob_pattern, $.extglob_pattern),
      ))),
    )),

    _negated_extglob_word: _ => token(prec(1, seq(
      EXTGLOB_NEGATION,
      repeat(choice(noneOf(...WORD_BREAKS), /\\[^\r\n]/, EXTGLOB_GROUP, EXTGLOB_NEGATION)),
    ))),

    concatenation: $ => prec.right(seq(
      $._word_part,
      repeat1(seq($._concat, choice(
        $._word_part,
        alias($._hash_word, $.word),
        alias($._negated_extglob_pattern, $.extglob_pattern),
      ))),
    )),

    _word_part: $ => choice(
      $.word,
      // Literal text that the scanner ends before a structured extglob group (`foo@($x)`).
      alias($._extglob_prefix, $.word),
      $.extglob_pattern,
      $.string,
      $.raw_string,
      $.ansi_c_string,
      $.translated_string,
      $.simple_expansion,
      $.expansion,
      $.command_substitution,
      $.arithmetic_expansion,
      $.process_substitution,
      alias($._bare_dollar, $.word),
    ),

    // An extglob group (`@(a|b)`) is part of the word; `!(` only inside a word, since a leading `!`
    // before `(` negates a subshell.
    word: _ => token(seq(
      choice(noneOf('#', ...WORD_BREAKS), /\\[^\r\n]/, EXTGLOB_GROUP),
      repeat(choice(noneOf(...WORD_BREAKS), /\\[^\r\n]/, EXTGLOB_GROUP, EXTGLOB_NEGATION)),
    )),

    // A `#` inside a word (`a$b#c`) is literal; only a `#` that begins a word starts a comment.
    // A group whose alternatives hold expansions (`@($(cmd)|b)`); a literal group stays inside a
    // `word`, whose token is longer than the group's opening token.
    extglob_pattern: $ => seq(
      field('operator', choice('?(', '*(', '+(', '@(')),
      optional($._extglob_alternative),
      repeat(seq('|', optional($._extglob_alternative))),
      ')',
    ),

    _negated_extglob_pattern: $ => seq(
      field('operator', '!('),
      optional($._extglob_alternative),
      repeat(seq('|', optional($._extglob_alternative))),
      ')',
    ),

    // An alternative may hold unquoted blanks, so each of its words is an `alternative` field; like
    // an assignment value, a word there may start with `#` (`@($x #b)`).
    _extglob_alternative: $ => repeat1(field('alternative', choice($._argument, $._hash_value))),

    _hash_word: _ => token(prec(1, seq(
      '#',
      repeat(choice(noneOf(...WORD_BREAKS), /\\[^\r\n]/, EXTGLOB_GROUP, EXTGLOB_NEGATION)),
    ))),

    string: $ => seq(
      '"',
      repeat(choice(
        $.string_content,
        $.simple_expansion,
        $.expansion,
        $.command_substitution,
        $.arithmetic_expansion,
      )),
      '"',
    ),

    raw_string: _ => /'[^']*'/,

    ansi_c_string: _ => /\$'([^'\\]|\\(.|\r?\n))*'/,

    translated_string: $ => seq('$"', repeat(choice(
      $.string_content,
      $.simple_expansion,
      $.expansion,
      $.command_substitution,
      $.arithmetic_expansion,
    )), '"'),

    simple_expansion: $ => seq(
      '$',
      choice(
        alias(token.immediate(/[A-Za-z_][A-Za-z0-9_]*/), $.variable_name),
        alias(token.immediate(/[0-9*@#?$!_-]/), $.special_variable_name),
      ),
    ),

    // `${#}` and `${!}` are the special parameters `#` and `!`; with a following name they are the
    // length and indirection prefixes.
    expansion: $ => seq(
      '${',
      choice(
        seq(
          optional(field('prefix', alias(token.immediate(choice('#', '!')), $.operator))),
          field('parameter', choice(
            alias(token.immediate(/[A-Za-z_][A-Za-z0-9_]*/), $.variable_name),
            alias(token.immediate(/[0-9]+|[*@?$_-]/), $.special_variable_name),
            alias(token.immediate(choice('#', '!')), $.special_variable_name),
            alias($._expansion_subscript, $.subscript),
            // A blank directly after `${` opens a function substitution, so these only take effect
            // after a prefix (`${# y}`), which bash parses and rejects only when expanding.
            alias(/[A-Za-z_][A-Za-z0-9_]*/, $.variable_name),
            alias(/[0-9]+|[*@?$_-]/, $.special_variable_name),
          )),
          optional($._expansion_operation),
        ),
        field('parameter', alias(token.immediate(choice('#', '!')), $.special_variable_name)),
        // Bash rejects `${}` and a body without a parameter (`${=1}`, `${"x"}`) only when expanding. A
        // `$name` expansion is left out, since its `$` would tie with the special parameter in `${$}`.
        repeat(field('argument', choice(
          alias($._expansion_text, $.word),
          alias($._angle_text, $.word),
          $.string,
          $.raw_string,
          $.ansi_c_string,
          $.translated_string,
          $.command_substitution,
        ))),
      ),
      '}',
    ),

    _expansion_subscript: $ => seq(
      field('name', alias(token.immediate(/[A-Za-z_][A-Za-z0-9_]*/), $.variable_name)),
      repeat1(seq(token.immediate('['), field('index', $._subscript_index), ']')),
    ),

    _expansion_operation: $ => choice(
      seq(
        field('operator', alias(
          token.immediate(choice(
            ':-', '-', ':=', '=', ':?', '?', ':+', '+', '#', '##', '%', '%%',
            '^', '^^', ',', ',,', '~', '~~', '/', '//', '/#', '/%', ':', '@',
          )),
          $.operator,
        )),
        repeat(field('argument', choice(
          alias($._expansion_text, $.word),
          alias($._angle_text, $.word),
          $._quoted_or_expansion,
          alias($._bare_dollar, $.word),
        ))),
      ),
      field('operator', alias(token.immediate(choice('*', '@')), $.operator)),
      // Text without an operator (`${x y}`) is rejected by bash only when expanding.
      repeat1(field('argument', choice(
        alias($._expansion_text, $.word),
        alias($._angle_text, $.word),
        $._quoted_or_expansion,
      ))),
    ),

    _expansion_text: _ => token(prec(-1, /([^}$`"'\\<>]|[<>]+[^(}$`"'\\<>]|\\(.|\r?\n))+/)),

    // A `<` or `>` that the text above cannot end with, e.g. before `}`. A single character, so that a
    // run before `(` leaves its last `<`/`>` to open a process substitution (`${x:-a<<(b)}`).
    _angle_text: _ => token(prec(-1, /[<>]/)),

    // The zero-width substitution markers let the scanner track nesting, since a heredoc opened
    // inside a substitution has its body read before the substitution ends.
    command_substitution: $ => choice(
      seq('$(', $._substitution_start, optional($._statements), $._substitution_end, ')'),
      // bash 5.3 runs `${ list; }` and `${| list; }` in the current shell.
      seq(
        alias(token(/\$\{[\s|]/), '${'),
        $._brace_substitution_start,
        optional($._terminated_statements),
        $._brace_substitution_end,
        '}',
      ),
      seq(alias($._backtick_open, '`'), optional($._statements), alias($._backtick_close, '`')),
    ),

    process_substitution: $ => seq(
      choice('<(', '>('),
      $._substitution_start,
      optional($._statements),
      $._substitution_end,
      ')',
    ),

    // Arithmetic may span lines, and a heredoc body starts only after it, so it counts as nesting.
    arithmetic_expansion: $ => choice(
      seq('$((', $._substitution_start, optional($._arithmetic_expression), $._substitution_end, '))'),
      seq('$[', $._bracket_substitution_start, optional($._arithmetic_expression), $._bracket_substitution_end, ']'),
    ),

    // Arithmetic

    _arithmetic_expression: $ => choice(
      $.number,
      alias($._arithmetic_variable, $.variable_name),
      alias($._arithmetic_subscript, $.subscript),
      $.simple_expansion,
      $.expansion,
      $.command_substitution,
      $.arithmetic_expansion,
      $.string,
      alias($._arithmetic_unary, $.unary_expression),
      alias($._arithmetic_postfix, $.postfix_expression),
      alias($._arithmetic_binary, $.binary_expression),
      alias($._arithmetic_ternary, $.ternary_expression),
      alias($._arithmetic_parenthesized, $.parenthesized_expression),
    ),

    number: $ => choice(
      /(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z@_]+|[0-9]+)/,
      // The digits of a based number may come from an expansion (`10#${x}`).
      seq(/[0-9]+#/, choice($.simple_expansion, $.expansion)),
    ),

    _arithmetic_variable: _ => /[A-Za-z_][A-Za-z0-9_]*/,

    _arithmetic_subscript: $ => seq(
      field('name', alias($._arithmetic_variable, $.variable_name)),
      token.immediate('['),
      field('index', $._arithmetic_expression),
      ']',
    ),

    _arithmetic_unary: $ => choice(
      prec(PREC.PREFIX, seq(field('operator', choice('++', '--')), $._arithmetic_expression)),
      prec(PREC.UNARY, seq(field('operator', choice('-', '+', '!', '~')), $._arithmetic_expression)),
    ),

    _arithmetic_postfix: $ => prec(PREC.POSTFIX, seq($._arithmetic_expression, field('operator', choice('++', '--')))),

    _arithmetic_binary: $ => {
      const table = [
        [PREC.COMMA, ','],
        [PREC.ASSIGN, choice('=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '&=', '^=', '|=')],
        [PREC.LOGICAL_OR, '||'],
        [PREC.LOGICAL_AND, '&&'],
        [PREC.BITWISE_OR, '|'],
        [PREC.BITWISE_XOR, '^'],
        [PREC.BITWISE_AND, '&'],
        [PREC.EQUALITY, choice('==', '!=')],
        [PREC.COMPARE, choice('<', '>', '<=', '>=')],
        [PREC.SHIFT, choice('<<', '>>')],
        [PREC.ADD, choice('+', '-')],
        [PREC.MULTIPLY, choice('*', '/', '%')],
        [PREC.EXPONENT, '**'],
      ];
      return choice(...table.map(([precedence, operator]) => {
        const associativity = precedence === PREC.ASSIGN || precedence === PREC.EXPONENT ? prec.right : prec.left;
        return associativity(/** @type {number} */ (precedence), seq(
          field('left', $._arithmetic_expression),
          field('operator', /** @type {RuleOrLiteral} */ (operator)),
          field('right', $._arithmetic_expression),
        ));
      }));
    },

    _arithmetic_ternary: $ => prec.right(PREC.TERNARY, seq(
      field('condition', $._arithmetic_expression),
      '?',
      field('consequence', $._arithmetic_expression),
      ':',
      field('alternative', $._arithmetic_expression),
    )),

    _arithmetic_parenthesized: $ => seq('(', $._arithmetic_expression, ')'),

    comment: _ => token(prec(-10, /#.*/)),
  },
});

/**
 * A regular expression matching any single character except the given ones.
 *
 * @param {...string} characters
 * @returns {RegExp}
 */
function noneOf(...characters) {
  return new RegExp(`[^${characters.join('')}]`);
}

/**
 * A regular expression matching a literal extglob group opened by `prefix`, whose body may contain
 * groups nested up to `depth` levels.
 *
 * @param {string} prefix
 * @param {number} depth
 * @returns {RegExp}
 */
function extglobGroup(prefix, depth) {
  // Quotes and expansions are left to `extglob_pattern`, which parses them. Blanks and newlines are
  // part of a group, as bash's extglob lexer keeps them in the word.
  const literal = '[^()\\\\$`\'"]';
  let body = `(?:${literal}|\\\\.)`;
  for (let level = 1; level < depth; level++) {
    body = `(?:${literal}|\\\\.|[?*+@!]\\(${body}*\\))`;
  }
  return new RegExp(`${prefix}\\(${body}*\\)`);
}
