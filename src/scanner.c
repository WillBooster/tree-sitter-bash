#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <string.h>
#include <wctype.h>

// Must match the order of `externals` in grammar.js.
enum TokenType {
    HEREDOC_START,
    HEREDOC_BODY_START,
    HEREDOC_CONTENT,
    HEREDOC_END,
    HEREDOC_ARROW,
    HEREDOC_ARROW_DASH,
    CONCAT,
    FILE_DESCRIPTOR,
    VARIABLE_NAME,
    BARE_DOLLAR,
    EMPTY_VALUE,
    REGEX,
    STRING_CONTENT,
    BACKTICK_OPEN,
    BACKTICK_CLOSE,
    NEWLINE,
    SUBSTITUTION_START,
    SUBSTITUTION_END,
    BRACE_SUBSTITUTION_END,
    BRACKET_SUBSTITUTION_END,
    EXTGLOB_PREFIX,
    LINE_CONTINUATION,
    BRACE_SUBSTITUTION_START,
    BRACKET_SUBSTITUTION_START,
    ERROR_RECOVERY,
};

typedef Array(int32_t) CodePoints;

// A heredoc whose `<<` operator has been read. Its body starts at the next newline that ends a line
// (not one inside a string) at the substitution depth where the operator appeared, after the bodies
// of heredocs opened earlier at that depth: bash reads a substitution, including the bodies of the
// heredocs inside it, before the body of a heredoc whose operator precedes it on the same line.
typedef struct {
    bool is_raw;
    bool allows_indent;
    bool started;
    uint16_t depth;
    CodePoints delimiter;
} Heredoc;

typedef struct {
    Array(Heredoc) heredocs;
    // Inside backquotes an unescaped backquote always closes the substitution, so the depth decides
    // whether a backquote opens or closes one.
    uint8_t backtick_depth;
    // The closer (`)`, `}`, or `]`) of each open substitution, innermost last.
    Array(uint8_t) closers;
    // A heredoc body ended right before a `${ list; }` closer; the newline that ended the command's
    // line began the body, so a terminator is still owed before the `}`.
    bool terminator_owed;
} Scanner;

static inline uint16_t current_depth(Scanner *scanner) {
    return scanner->backtick_depth + scanner->closers.size;
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline bool is_metacharacter(int32_t c) {
    return c == '|' || c == '&' || c == ';' || c == '(' || c == ')' || c == '<' || c == '>';
}

static inline bool is_blank(int32_t c) { return c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == '\v'; }

static inline bool is_name_start(int32_t c) { return iswalpha(c) || c == '_'; }

static inline bool is_name_char(int32_t c) { return iswalnum(c) || c == '_'; }

// Whether `$` followed by `c` begins an expansion inside double quotes or a heredoc body.
static inline bool starts_quoted_expansion(int32_t c) {
    return is_name_start(c) || iswdigit(c) || c == '{' || c == '(' || c == '[' || c == '*' || c == '@' ||
           c == '#' || c == '?' || c == '$' || c == '!' || c == '-';
}

// Code points are serialized as zigzag varints, one byte for code points below 64 and two for the
// rest of ASCII; every int32 round-trips, including the negative value the lexer reports for invalid
// UTF-8.
static unsigned varint_length(int32_t c) {
    uint32_t value = ((uint32_t)c << 1) ^ (uint32_t)(c >> 31);
    unsigned length = 1;
    while (value >= 0x80) {
        value >>= 7;
        length++;
    }
    return length;
}

static unsigned encode_varint(int32_t c, char *out) {
    uint32_t value = ((uint32_t)c << 1) ^ (uint32_t)(c >> 31);
    unsigned length = 0;
    while (value >= 0x80) {
        out[length++] = (char)(0x80 | (value & 0x7F));
        value >>= 7;
    }
    out[length++] = (char)value;
    return length;
}

// Returns 0 when the input ends before the varint does.
static unsigned decode_varint(const char *in, unsigned available, int32_t *c) {
    uint32_t value = 0;
    for (unsigned i = 0; i < available && i < 5; i++) {
        value |= (uint32_t)((unsigned char)in[i] & 0x7F) << (7 * i);
        if (((unsigned char)in[i] & 0x80) == 0) {
            *c = (int32_t)((value >> 1) ^ (0u - (value & 1)));
            return i + 1;
        }
    }
    return 0;
}

// Serialized layout: backtick depth, the owed-terminator flag, the closers of the open substitutions
// (uint16 count, then one byte each), and heredoc count, then per heredoc its flags, depth (uint16),
// delimiter length (uint16), and the delimiter as varints.
#define HEREDOC_HEADER_SIZE (3 + 2 * sizeof(uint16_t))

static unsigned serialized_size(Scanner *scanner) {
    unsigned size = 3 + sizeof(uint16_t) + scanner->closers.size;
    for (uint32_t i = 0; i < scanner->heredocs.size; i++) {
        Heredoc *heredoc = array_get(&scanner->heredocs, i);
        size += HEREDOC_HEADER_SIZE;
        for (uint32_t j = 0; j < heredoc->delimiter.size; j++) {
            size += varint_length(*array_get(&heredoc->delimiter, j));
        }
    }
    return size;
}

static void heredoc_delete(Heredoc *heredoc) { array_delete(&heredoc->delimiter); }

static void scanner_reset(Scanner *scanner) {
    for (uint32_t i = 0; i < scanner->heredocs.size; i++) {
        heredoc_delete(array_get(&scanner->heredocs, i));
    }
    array_clear(&scanner->heredocs);
    scanner->backtick_depth = 0;
    array_clear(&scanner->closers);
    scanner->terminator_owed = false;
}

// The body being read: the most deeply nested started heredoc.
static int32_t active_heredoc_index(Scanner *scanner) {
    int32_t active = -1;
    for (uint32_t i = 0; i < scanner->heredocs.size; i++) {
        Heredoc *heredoc = array_get(&scanner->heredocs, i);
        if (heredoc->started && (active < 0 || heredoc->depth >= array_get(&scanner->heredocs, active)->depth)) {
            active = (int32_t)i;
        }
    }
    return active;
}

// The next body to start: the first unstarted heredoc opened at the current substitution depth.
static int32_t next_heredoc_index(Scanner *scanner) {
    uint16_t depth = current_depth(scanner);
    for (uint32_t i = 0; i < scanner->heredocs.size; i++) {
        Heredoc *heredoc = array_get(&scanner->heredocs, i);
        if (!heredoc->started && heredoc->depth == depth) {
            return (int32_t)i;
        }
    }
    return -1;
}

// An entry without a delimiter belongs to an operator whose delimiter was rejected.
static inline bool is_rejected(Heredoc *heredoc) { return heredoc->delimiter.size == 0 && !heredoc->is_raw; }

// Drops the unstarted heredocs at the current depth, which were all queued on the line just ended.
static void drop_unstarted_heredocs_at_depth(Scanner *scanner) {
    uint16_t depth = current_depth(scanner);
    for (uint32_t i = scanner->heredocs.size; i > 0; i--) {
        Heredoc *heredoc = array_get(&scanner->heredocs, i - 1);
        if (!heredoc->started && heredoc->depth == depth) {
            heredoc_delete(heredoc);
            array_erase(&scanner->heredocs, i - 1);
        }
    }
}

static void remove_heredoc(Scanner *scanner, uint32_t index) {
    heredoc_delete(array_get(&scanner->heredocs, index));
    array_erase(&scanner->heredocs, index);
}

// Like bash, drop the heredocs of a substitution that closes before their bodies started.
static void discard_unstarted_heredocs(Scanner *scanner) {
    uint16_t depth = current_depth(scanner);
    for (uint32_t i = scanner->heredocs.size; i > 0; i--) {
        Heredoc *heredoc = array_get(&scanner->heredocs, i - 1);
        if (!heredoc->started && heredoc->depth > depth) {
            remove_heredoc(scanner, i - 1);
        }
    }
}

// Heredoc bodies: the body starts at the newline ending the header line and ends with the delimiter
// line (or at the end of input, as bash does with a warning). An unquoted body stops before each
// expansion so that the parser can read it.
static bool scan_heredoc_content(Scanner *scanner, TSLexer *lexer, uint32_t index) {
    Heredoc *heredoc = array_get(&scanner->heredocs, index);
    bool did_advance = false;
    bool at_line_start = lexer->get_column(lexer) == 0;

    for (;;) {
        if (at_line_start) {
            at_line_start = false;
            lexer->mark_end(lexer);
            // Like bash, compare the delimiter with the line after joining backslash-newlines and
            // then stripping the leading tabs of `<<-`. As elsewhere in the grammar, CRLF counts as a
            // newline.
            bool consumed = false;
            bool escaped = false;
            uint32_t matched = 0;
            // At the end of input the lookahead is 0, which a delimiter holding NUL would otherwise match.
            for (;;) {
                if (matched == 0 && heredoc->allows_indent && lexer->lookahead == '\t') {
                    advance(lexer);
                    consumed = true;
                } else if (lexer->lookahead == '\\' && !heredoc->is_raw) {
                    advance(lexer);
                    consumed = true;
                    bool escaped_cr = lexer->lookahead == '\r';
                    if (escaped_cr) {
                        advance(lexer);
                    }
                    if (lexer->lookahead != '\n' || lexer->eof(lexer)) {
                        // An escape rather than a line continuation: the escaped character, which is
                        // the CR itself when no LF follows it, is content.
                        if (!escaped_cr && !lexer->eof(lexer)) {
                            advance(lexer);
                        }
                        escaped = true;
                        break;
                    }
                    advance(lexer);
                } else if (matched < heredoc->delimiter.size && !lexer->eof(lexer) &&
                           lexer->lookahead == *array_get(&heredoc->delimiter, matched)) {
                    advance(lexer);
                    matched++;
                } else {
                    break;
                }
            }
            if (!escaped && lexer->lookahead == '\r') {
                advance(lexer);
            }
            // Inside a substitution, bash also ends the body at a delimiter directly followed by the
            // innermost substitution's closer (`)` or `}`) or a closing backquote.
            bool ends_line = lexer->lookahead == '\n' || lexer->eof(lexer) ||
                             (scanner->closers.size > 0 && lexer->lookahead == *array_back(&scanner->closers)) ||
                             (lexer->lookahead == '`' && scanner->backtick_depth > 0);
            if (!escaped && matched == heredoc->delimiter.size && ends_line) {
                if (did_advance) {
                    lexer->result_symbol = HEREDOC_CONTENT;
                    return true;
                }
                lexer->mark_end(lexer);
                lexer->result_symbol = HEREDOC_END;
                scanner->terminator_owed = lexer->lookahead == '}';
                remove_heredoc(scanner, index);
                return true;
            }
            // The characters read while trying the delimiter are content; an empty attempt must not
            // count, or a zero-width content token would repeat forever.
            did_advance = did_advance || consumed || matched > 0;
            continue;
        }

        if (lexer->eof(lexer)) {
            lexer->mark_end(lexer);
            lexer->result_symbol = did_advance ? HEREDOC_CONTENT : HEREDOC_END;
            if (!did_advance) {
                remove_heredoc(scanner, index);
            }
            return true;
        }

        switch (lexer->lookahead) {
            case '\n':
                advance(lexer);
                did_advance = true;
                at_line_start = true;
                break;
            case '\\':
                advance(lexer);
                did_advance = true;
                if (!heredoc->is_raw && !lexer->eof(lexer)) {
                    // A backslash-newline joins lines before the delimiter comparison. A CR without an
                    // LF after it is the escaped character itself.
                    if (lexer->lookahead == '\r') {
                        advance(lexer);
                        if (lexer->lookahead == '\n') {
                            advance(lexer);
                        }
                    } else if (!lexer->eof(lexer)) {
                        advance(lexer);
                    }
                }
                break;
            case '`':
                if (!heredoc->is_raw) {
                    lexer->mark_end(lexer);
                    lexer->result_symbol = HEREDOC_CONTENT;
                    return did_advance;
                }
                advance(lexer);
                did_advance = true;
                break;
            case '$':
                if (!heredoc->is_raw) {
                    lexer->mark_end(lexer);
                    advance(lexer);
                    if (starts_quoted_expansion(lexer->lookahead)) {
                        if (!did_advance) {
                            return false;
                        }
                        lexer->result_symbol = HEREDOC_CONTENT;
                        return true;
                    }
                    did_advance = true;
                    break;
                }
                advance(lexer);
                did_advance = true;
                break;
            default:
                advance(lexer);
                did_advance = true;
                break;
        }
    }
}

// The delimiter word undergoes quote removal; any quoting makes the body literal.
static inline int32_t hex_value(int32_t c) {
    return iswdigit(c) ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
}

// Reads up to `max_digits` digits in `base` and returns their value, or -1 when there are none.
static int32_t read_number(TSLexer *lexer, int32_t base, int max_digits) {
    int32_t value = 0;
    int digits = 0;
    while (digits < max_digits) {
        int32_t digit = hex_value(lexer->lookahead);
        if (digit < 0 || digit >= base) {
            break;
        }
        value = value * base + digit;
        advance(lexer);
        digits++;
    }
    return digits == 0 ? -1 : value;
}

// Decodes the escape after a backslash in `$'...'` as bash does, appending it to `out`.
static void push_ansi_c_escape(TSLexer *lexer, CodePoints *out) {
    int32_t c = lexer->lookahead;
    int32_t value = -1;
    switch (c) {
        case 'a': value = 7; break;
        case 'b': value = 8; break;
        case 'e':
        case 'E': value = 27; break;
        case 'f': value = 12; break;
        case 'n': value = '\n'; break;
        case 'r': value = '\r'; break;
        case 't': value = '\t'; break;
        case 'v': value = 11; break;
        case '\\':
        case '\'':
        case '"':
        case '?': value = c; break;
        default: break;
    }
    if (value >= 0) {
        advance(lexer);
        array_push(out, value);
        return;
    }
    if (c >= '0' && c <= '7') {
        array_push(out, read_number(lexer, 8, 3));
        return;
    }
    int max_digits = c == 'x' ? 2 : c == 'u' ? 4 : c == 'U' ? 8 : 0;
    if (max_digits > 0) {
        advance(lexer);
        value = read_number(lexer, 16, max_digits);
        if (value < 0) {
            array_push(out, '\\');
            array_push(out, c);
        } else {
            array_push(out, value);
        }
        return;
    }
    if (c == 'c') {
        advance(lexer);
        if (!lexer->eof(lexer)) {
            array_push(out, lexer->lookahead & 0x1F);
            advance(lexer);
        }
        return;
    }
    // Bash keeps an unknown escape as written.
    array_push(out, '\\');
}

static bool scan_heredoc_start(Scanner *scanner, TSLexer *lexer) {
    Heredoc *heredoc = array_back(&scanner->heredocs);
    array_clear(&heredoc->delimiter);
    heredoc->is_raw = false;

    while (is_blank(lexer->lookahead)) {
        skip(lexer);
    }

    int32_t quote = 0;
    bool ansi_c = false;
    while (!lexer->eof(lexer)) {
        int32_t c = lexer->lookahead;
        if (quote) {
            advance(lexer);
            if (c == quote) {
                quote = 0;
                continue;
            }
            if (ansi_c && c == '\\') {
                if (!lexer->eof(lexer)) {
                    push_ansi_c_escape(lexer, &heredoc->delimiter);
                }
                continue;
            }
            // Inside double quotes a backslash-newline still only continues the line.
            if (quote == '"' && c == '\\' && (lexer->lookahead == '\n' || lexer->lookahead == '\r')) {
                if (lexer->lookahead == '\r') {
                    advance(lexer);
                }
                if (lexer->lookahead == '\n') {
                    advance(lexer);
                    continue;
                }
                array_push(&heredoc->delimiter, '\\');
                array_push(&heredoc->delimiter, '\r');
                continue;
            }
            if (quote == '"' && c == '\\' &&
                (lexer->lookahead == '$' || lexer->lookahead == '`' || lexer->lookahead == '"' ||
                 lexer->lookahead == '\\')) {
                c = lexer->lookahead;
                advance(lexer);
            }
            array_push(&heredoc->delimiter, c);
            continue;
        }
        // Inside backquotes an unquoted backquote closes the substitution; at top level it is part of
        // the word (`<<EO`true`F`).
        if (iswspace(c) || is_metacharacter(c) || (c == '`' && scanner->backtick_depth > 0)) {
            break;
        }
        advance(lexer);
        if (c == '$' && (lexer->lookahead == '\'' || lexer->lookahead == '"')) {
            // `$'...'` and `$"..."` are quoting constructs, so their `$` is not part of the word.
            c = lexer->lookahead;
            advance(lexer);
            quote = c;
            ansi_c = c == '\'';
            heredoc->is_raw = true;
        } else if (c == '\'' || c == '"') {
            quote = c;
            ansi_c = false;
            heredoc->is_raw = true;
        } else if (c == '\\') {
            // A backslash-newline only continues the line; any other backslash quotes the delimiter.
            bool carriage_return = lexer->lookahead == '\r';
            if (carriage_return) {
                advance(lexer);
            }
            if (lexer->lookahead == '\n') {
                advance(lexer);
            } else if (carriage_return) {
                heredoc->is_raw = true;
                array_push(&heredoc->delimiter, '\r');
            } else if (!lexer->eof(lexer)) {
                heredoc->is_raw = true;
                array_push(&heredoc->delimiter, lexer->lookahead);
                advance(lexer);
            }
        } else {
            // Bash counts a backquote in the delimiter word as quoting, so the body stays literal.
            if (c == '`') {
                heredoc->is_raw = true;
            }
            array_push(&heredoc->delimiter, c);
        }
    }

    // A heredoc whose state cannot be serialized in full is rejected, so the parse shows an error
    // rather than comparing against a partial delimiter.
    if ((heredoc->delimiter.size == 0 && !heredoc->is_raw) ||
        serialized_size(scanner) > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
        return false;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = HEREDOC_START;
    return true;
}

static bool scan_heredoc_arrow(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    advance(lexer);
    if (lexer->lookahead != '<') {
        return false;
    }
    advance(lexer);
    bool allows_indent = false;
    if (lexer->lookahead == '<') {
        return false;
    }
    if (lexer->lookahead == '-' && valid_symbols[HEREDOC_ARROW_DASH]) {
        advance(lexer);
        allows_indent = true;
    } else if (!valid_symbols[HEREDOC_ARROW]) {
        return false;
    }
    if (scanner->heredocs.size >= UINT8_MAX ||
        serialized_size(scanner) + HEREDOC_HEADER_SIZE > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
        return false;
    }
    lexer->mark_end(lexer);
    Heredoc heredoc = {
        .is_raw = false,
        .allows_indent = allows_indent,
        .started = false,
        .depth = current_depth(scanner),
        .delimiter = array_new(),
    };
    array_push(&scanner->heredocs, heredoc);
    lexer->result_symbol = allows_indent ? HEREDOC_ARROW_DASH : HEREDOC_ARROW;
    return true;
}

// The right side of `=~` extends to unquoted whitespace outside parentheses.
static bool scan_regex(TSLexer *lexer) {
    while (is_blank(lexer->lookahead)) {
        skip(lexer);
    }
    uint32_t depth = 0;
    bool did_advance = false;
    while (!lexer->eof(lexer)) {
        lexer->mark_end(lexer);
        int32_t c = lexer->lookahead;
        if (depth == 0 && iswspace(c)) {
            break;
        }
        // Like bash, treat `|` and parentheses as regex characters, while other metacharacters end
        // the regex even without surrounding blanks (`[[ a =~ a&&b ]]`).
        if (depth == 0 && (c == '&' || c == ';' || c == '<' || c == '>')) {
            break;
        }
        if (c == '\\') {
            advance(lexer);
        } else if (c == '\'' || c == '"') {
            advance(lexer);
            while (!lexer->eof(lexer) && lexer->lookahead != c) {
                if (c == '"' && lexer->lookahead == '\\') {
                    advance(lexer);
                }
                advance(lexer);
            }
        } else if (c == '(') {
            depth++;
        } else if (c == ')') {
            if (depth == 0) {
                break;
            }
            depth--;
        }
        advance(lexer);
        did_advance = true;
    }
    if (lexer->eof(lexer)) {
        lexer->mark_end(lexer);
    }
    lexer->result_symbol = REGEX;
    return did_advance;
}

static bool scan_string_content(TSLexer *lexer) {
    bool did_advance = false;
    for (;;) {
        lexer->mark_end(lexer);
        if (lexer->eof(lexer)) {
            break;
        }
        int32_t c = lexer->lookahead;
        if (c == '"' || c == '`') {
            break;
        }
        advance(lexer);
        if (c == '$' && starts_quoted_expansion(lexer->lookahead)) {
            break;
        }
        if (c == '\\' && !lexer->eof(lexer)) {
            advance(lexer);
        }
        did_advance = true;
    }
    lexer->result_symbol = STRING_CONTENT;
    return did_advance;
}

static inline bool is_word_break(int32_t c) {
    return iswspace(c) || is_metacharacter(c) || c == '"' || c == '\'' || c == '`' || c == '$' || c == '\\';
}

static inline bool is_extglob_operator(int32_t c) { return c == '?' || c == '*' || c == '+' || c == '@' || c == '!'; }

typedef enum { GROUP_LITERAL, GROUP_STRUCTURED, GROUP_UNSUPPORTED } GroupKind;

// From the `(` of an extglob group, reads to its matching `)`: a group holding quotes or expansions
// is parsed as `extglob_pattern`, while the word token keeps literal ones.
// The nesting depth up to which grammar.js's word token lexes a literal group (`extglobGroup(…, 3)`);
// a deeper group is parsed as `extglob_pattern`.
#define EXTGLOB_LITERAL_DEPTH 3

static GroupKind scan_extglob_group(TSLexer *lexer) {
    uint32_t depth = 0;
    while (!lexer->eof(lexer)) {
        int32_t c = lexer->lookahead;
        if (c == '$' || c == '`' || c == '\'' || c == '"') {
            return GROUP_STRUCTURED;
        }
        advance(lexer);
        if (c == '\\') {
            // The word token's literal groups cannot hold a line continuation.
            if (lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == '\r') {
                return lexer->eof(lexer) ? GROUP_UNSUPPORTED : GROUP_STRUCTURED;
            }
            advance(lexer);
        } else if (c == '(') {
            if (++depth > EXTGLOB_LITERAL_DEPTH) {
                return GROUP_STRUCTURED;
            }
        } else if (c == ')' && --depth == 0) {
            return GROUP_LITERAL;
        }
    }
    return GROUP_UNSUPPORTED;
}

// The literal text of a word up to a structured extglob group (`foo` in `foo@($x)`), which the
// word token's longest match would otherwise run into.
static bool continue_extglob_prefix(TSLexer *lexer, bool consumed) {
    while (!lexer->eof(lexer)) {
        int32_t c = lexer->lookahead;
        if (is_extglob_operator(c)) {
            lexer->mark_end(lexer);
            advance(lexer);
            if (lexer->lookahead == '(') {
                GroupKind kind = scan_extglob_group(lexer);
                if (kind == GROUP_STRUCTURED) {
                    lexer->result_symbol = EXTGLOB_PREFIX;
                    return consumed;
                }
                if (kind == GROUP_UNSUPPORTED) {
                    return false;
                }
            }
        } else if (c == '\\') {
            advance(lexer);
            // A backslash-newline continues the line; the word token handles that.
            if (lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == '\r') {
                return false;
            }
            advance(lexer);
        } else if (is_word_break(c)) {
            return false;
        } else {
            advance(lexer);
        }
        consumed = true;
    }
    return false;
}

// A leading `#` starts a comment except in an assignment value (`A=#@($x)`).
static bool scan_extglob_prefix(TSLexer *lexer, bool in_value) {
    return (lexer->lookahead != '#' || in_value) && continue_extglob_prefix(lexer, false);
}

// Skips a quoted span from its opening quote through its closing one.
static void skip_quoted(TSLexer *lexer) {
    int32_t quote = lexer->lookahead;
    advance(lexer);
    while (!lexer->eof(lexer) && lexer->lookahead != quote) {
        if (lexer->lookahead == '\\' && quote != '\'') {
            advance(lexer);
            if (lexer->eof(lexer)) {
                return;
            }
        }
        advance(lexer);
    }
    advance(lexer);
}

// Skips a parenthesized span such as a command substitution's, quotes included.
static void skip_parenthesized(TSLexer *lexer) {
    uint32_t depth = 0;
    while (!lexer->eof(lexer)) {
        int32_t c = lexer->lookahead;
        if (c == '\'' || c == '"' || c == '`') {
            skip_quoted(lexer);
            continue;
        }
        if (c == '\\') {
            advance(lexer);
        } else if (c == '(') {
            depth++;
        } else if (c == ')' && --depth == 0) {
            advance(lexer);
            return;
        }
        advance(lexer);
    }
}

// A name at a position where both an assignment and a word may start: `name=`, `name+=`, and
// `name[…]=` are assignments, and otherwise the name may begin the literal text before a structured
// extglob group (`foo@($x)`), in which `+(` is an extglob operator rather than an unfinished `+=`.
static bool scan_name_or_extglob_prefix(TSLexer *lexer, const bool *valid_symbols) {
    while (is_name_char(lexer->lookahead)) {
        advance(lexer);
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = VARIABLE_NAME;
    if (lexer->lookahead == '=') {
        return true;
    }
    if (lexer->lookahead == '+') {
        advance(lexer);
        if (lexer->lookahead == '=') {
            return true;
        }
        if (!valid_symbols[EXTGLOB_PREFIX]) {
            return false;
        }
        if (lexer->lookahead == '(') {
            GroupKind kind = scan_extglob_group(lexer);
            lexer->result_symbol = EXTGLOB_PREFIX;
            return kind == GROUP_STRUCTURED || (kind == GROUP_LITERAL && continue_extglob_prefix(lexer, true));
        }
        return continue_extglob_prefix(lexer, true);
    }
    if (lexer->lookahead == '[') {
        // Like bash, the subscript extends to the matching `]` across lines; without one the name
        // still starts an assignment, so the parse reports the missing `]`.
        uint32_t depth = 0;
        while (!lexer->eof(lexer)) {
            int32_t c = lexer->lookahead;
            if (c == '[') {
                depth++;
            } else if (c == ']' && --depth == 0) {
                advance(lexer);
                break;
            } else if (c == '\\') {
                advance(lexer);
            } else if (c == '\'' || c == '"' || c == '`') {
                // Brackets inside quotes do not count (`A["]"]=x`).
                skip_quoted(lexer);
                continue;
            } else if (c == '$') {
                advance(lexer);
                if (lexer->lookahead == '(') {
                    skip_parenthesized(lexer);
                }
                continue;
            }
            advance(lexer);
        }
        if (depth == 0 && lexer->lookahead == '+') {
            advance(lexer);
        }
        if (depth != 0 || lexer->lookahead == '=') {
            return true;
        }
        return valid_symbols[EXTGLOB_PREFIX] && continue_extglob_prefix(lexer, true);
    }
    return valid_symbols[EXTGLOB_PREFIX] && continue_extglob_prefix(lexer, true);
}

// Marks the current position and reports whether a reserved word that ends or continues a compound
// command (`then`, `do`, `done`, `fi`, `esac`, `else`, `elif`, `}`) starts here.
static bool at_closing_reserved_word(TSLexer *lexer) {
    static const char *const words[] = {"then", "do", "done", "fi", "esac", "else", "elif", "}"};
    lexer->mark_end(lexer);
    char word[5];
    uint32_t length = 0;
    while (length < sizeof(word) && (iswlower(lexer->lookahead) || lexer->lookahead == '}')) {
        word[length++] = (char)lexer->lookahead;
        advance(lexer);
    }
    if (length == 0 || length == sizeof(word) ||
        !(lexer->eof(lexer) || iswspace(lexer->lookahead) || is_metacharacter(lexer->lookahead))) {
        return false;
    }
    for (size_t i = 0; i < sizeof(words) / sizeof(words[0]); i++) {
        if (strlen(words[i]) == length && strncmp(words[i], word, length) == 0) {
            return true;
        }
    }
    return false;
}

static bool scan(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    bool error_recovery = valid_symbols[ERROR_RECOVERY];
    // Tokens that must touch the previous one (concatenation, an empty assignment value) are decided
    // by the character right after it, even when blanks are skipped below to find a newline.
    int32_t first = lexer->lookahead;
    bool at_eof = lexer->eof(lexer);

    if (scanner->terminator_owed) {
        scanner->terminator_owed = false;
        if (valid_symbols[NEWLINE] && lexer->lookahead == '}') {
            lexer->result_symbol = NEWLINE;
            return true;
        }
    }

    // Counted before a heredoc body may start, so a newline right after `$(` is inside it.
    if (!error_recovery &&
        (valid_symbols[SUBSTITUTION_START] || valid_symbols[BRACE_SUBSTITUTION_START] ||
         valid_symbols[BRACKET_SUBSTITUTION_START])) {
        // Nesting too deep for the serialized state is left to the parse as an error.
        if (serialized_size(scanner) >= TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
            return false;
        }
        lexer->result_symbol = valid_symbols[SUBSTITUTION_START]         ? SUBSTITUTION_START
                               : valid_symbols[BRACE_SUBSTITUTION_START] ? BRACE_SUBSTITUTION_START
                                                                         : BRACKET_SUBSTITUTION_START;
        uint8_t closer = lexer->result_symbol == SUBSTITUTION_START         ? ')'
                         : lexer->result_symbol == BRACE_SUBSTITUTION_START ? '}'
                                                                            : ']';
        array_push(&scanner->closers, closer);
        return true;
    }

    if (scanner->heredocs.size > 0) {
        int32_t active = active_heredoc_index(scanner);
        if (active >= 0 && (valid_symbols[HEREDOC_CONTENT] || valid_symbols[HEREDOC_END]) &&
            !(lexer->lookahead == '`' && !array_get(&scanner->heredocs, active)->is_raw)) {
            return scan_heredoc_content(scanner, lexer, (uint32_t)active);
        }
        // A newline inside a string is part of it, so bodies start only outside strings.
        int32_t next = next_heredoc_index(scanner);
        if (next >= 0 && valid_symbols[HEREDOC_BODY_START] && !valid_symbols[STRING_CONTENT]) {
            while (is_blank(lexer->lookahead)) {
                skip(lexer);
            }
            if (lexer->lookahead == '\n') {
                // The line's heredocs cannot be located once one of them was rejected, so none gets a
                // body; scanning continues so that the change is kept with the token found below.
                if (is_rejected(array_get(&scanner->heredocs, next))) {
                    drop_unstarted_heredocs_at_depth(scanner);
                } else {
                    array_get(&scanner->heredocs, next)->started = true;
                    lexer->result_symbol = HEREDOC_BODY_START;
                    return true;
                }
            }
        }
    }

    if (error_recovery) {
        return false;
    }

    if (valid_symbols[STRING_CONTENT] && lexer->lookahead != '`') {
        return scan_string_content(lexer);
    }

    if (valid_symbols[HEREDOC_START] && scanner->heredocs.size > 0) {
        return scan_heredoc_start(scanner, lexer);
    }

    // A token that ends a line (a line continuation after a blank, a heredoc body) separates words, so
    // nothing concatenates at the start of a line. The column is checked only where a concatenation
    // could start, since computing it costs a scan back to the line start.
    if (valid_symbols[CONCAT] && !at_eof && !iswspace(first) && lexer->get_column(lexer) != 0) {
        int32_t c = first;
        if (c == '\\' && lexer->lookahead == '\\') {
            // A backslash-newline joins lines, so the word continues only if the next line does.
            lexer->mark_end(lexer);
            advance(lexer);
            if (lexer->lookahead == '\r') {
                advance(lexer);
            }
            // Bash drops a backslash at the end of input like a continuation.
            if (lexer->eof(lexer)) {
                lexer->mark_end(lexer);
                lexer->result_symbol = LINE_CONTINUATION;
                return true;
            }
            if (lexer->lookahead != '\n') {
                lexer->result_symbol = CONCAT;
                return true;
            }
            advance(lexer);
            lexer->mark_end(lexer);
            c = lexer->lookahead;
            // The word continues only if the next line does; otherwise the continuation itself is the
            // token, so that whatever follows it is lexed as it would be without it.
            lexer->result_symbol = LINE_CONTINUATION;
            if (lexer->eof(lexer) || iswspace(c) || is_metacharacter(c) || (c == '`' && scanner->backtick_depth > 0)) {
                return true;
            }
            if (c == '\\') {
                // Another continuation is whitespace too; an escaped character continues the word.
                advance(lexer);
                if (lexer->lookahead == '\r') {
                    advance(lexer);
                }
                if (lexer->lookahead == '\n' || lexer->eof(lexer)) {
                    return true;
                }
            }
            lexer->result_symbol = CONCAT;
            return true;
        }
        if (!at_eof && !iswspace(c) && !is_metacharacter(c) && !(c == '`' && scanner->backtick_depth > 0)) {
            lexer->result_symbol = CONCAT;
            return true;
        }
    }

    if (valid_symbols[EMPTY_VALUE]) {
        int32_t c = first;
        // A redirection may follow an empty value (`A=>f`), but `<(`/`>(` is a process substitution
        // value; nothing else a value may start with begins with `<` or `>`.
        if ((c == '<' || c == '>') && lexer->lookahead == c) {
            lexer->mark_end(lexer);
            advance(lexer);
            if (lexer->lookahead == '(') {
                return false;
            }
            lexer->result_symbol = EMPTY_VALUE;
            return true;
        }
        if (at_eof || iswspace(c) || c == ';' || c == '&' || c == '|' || c == ')' ||
            (c == '`' && scanner->backtick_depth > 0)) {
            lexer->result_symbol = EMPTY_VALUE;
            return true;
        }
    }

    if (valid_symbols[REGEX]) {
        return scan_regex(lexer);
    }

    // A newline ends a statement where a terminator may follow and is whitespace elsewhere.
    for (;;) {
        if (is_blank(lexer->lookahead)) {
            skip(lexer);
        } else if (lexer->lookahead == '\n') {
            if (valid_symbols[NEWLINE]) {
                advance(lexer);
                lexer->mark_end(lexer);
                lexer->result_symbol = NEWLINE;
                return true;
            }
            skip(lexer);
        } else if (lexer->lookahead == '\\') {
            // A continuation is returned as a token, since tree-sitter's lexer cannot always resume
            // after one; a backslash escaping a word's first character can only start an extglob prefix
            // (`\foo@($x)`), and the word token handles it otherwise.
            advance(lexer);
            if (lexer->lookahead == '\r') {
                advance(lexer);
            }
            if (lexer->lookahead == '\n' || lexer->eof(lexer)) {
                advance(lexer);
                lexer->mark_end(lexer);
                lexer->result_symbol = LINE_CONTINUATION;
                return true;
            }
            if (valid_symbols[EXTGLOB_PREFIX]) {
                advance(lexer);
                return continue_extglob_prefix(lexer, true);
            }
            return false;
        } else {
            break;
        }
    }

    // Each closer has its own marker, so a `]` or `}` argument inside `$( )` does not end it.
    enum TokenType end = valid_symbols[SUBSTITUTION_END] && lexer->lookahead == ')'               ? SUBSTITUTION_END
                         : valid_symbols[BRACE_SUBSTITUTION_END] && lexer->lookahead == '}'   ? BRACE_SUBSTITUTION_END
                         : valid_symbols[BRACKET_SUBSTITUTION_END] && lexer->lookahead == ']' ? BRACKET_SUBSTITUTION_END
                                                                                              : ERROR_RECOVERY;
    if (end != ERROR_RECOVERY) {
        if (scanner->closers.size > 0) {
            array_pop(&scanner->closers);
        }
        discard_unstarted_heredocs(scanner);
        lexer->result_symbol = end;
        return true;
    }

    // Bash ends backquotes at the first unescaped backquote, even inside single quotes (`echo '`),
    // and then reports the unterminated quote when it runs the substitution. So a quote that the next
    // backquote cuts short closes the substitution there when it may close, and otherwise is skipped
    // up to the backquote, which then cannot be parsed; the quote never hides the text after it.
    if (scanner->backtick_depth > 0 && lexer->lookahead == '\'') {
        advance(lexer);
        while (!lexer->eof(lexer) && lexer->lookahead != '\'' && lexer->lookahead != '`') {
            if (lexer->lookahead == '\\') {
                advance(lexer);
                if (lexer->eof(lexer)) {
                    break;
                }
            }
            advance(lexer);
        }
        if (lexer->lookahead != '`') {
            return false;
        }
        if (valid_symbols[BACKTICK_CLOSE]) {
            advance(lexer);
            lexer->mark_end(lexer);
            scanner->backtick_depth--;
            discard_unstarted_heredocs(scanner);
            lexer->result_symbol = BACKTICK_CLOSE;
            return true;
        }
        lexer->mark_end(lexer);
        lexer->result_symbol = LINE_CONTINUATION;
        return true;
    }

    if ((valid_symbols[BACKTICK_OPEN] || valid_symbols[BACKTICK_CLOSE]) && lexer->lookahead == '`') {
        if (scanner->backtick_depth > 0 && valid_symbols[BACKTICK_CLOSE]) {
            advance(lexer);
            lexer->mark_end(lexer);
            scanner->backtick_depth--;
            discard_unstarted_heredocs(scanner);
            lexer->result_symbol = BACKTICK_CLOSE;
            return true;
        }
        if (scanner->backtick_depth == 0 && valid_symbols[BACKTICK_OPEN]) {
            advance(lexer);
            lexer->mark_end(lexer);
            scanner->backtick_depth++;
            lexer->result_symbol = BACKTICK_OPEN;
            return true;
        }
    }

    if ((valid_symbols[HEREDOC_ARROW] || valid_symbols[HEREDOC_ARROW_DASH]) && lexer->lookahead == '<') {
        return scan_heredoc_arrow(scanner, lexer, valid_symbols);
    }

    // Only one check that consumes input can run, so the prefix scan leaves names before a possible
    // assignment to their own check; digits are read once as a descriptor or a word prefix.
    if (valid_symbols[FILE_DESCRIPTOR] && iswdigit(lexer->lookahead)) {
        while (iswdigit(lexer->lookahead)) {
            advance(lexer);
        }
        lexer->mark_end(lexer);
        lexer->result_symbol = FILE_DESCRIPTOR;
        if (lexer->lookahead == '<' || lexer->lookahead == '>') {
            return true;
        }
        return valid_symbols[EXTGLOB_PREFIX] && continue_extglob_prefix(lexer, true);
    }

    if (valid_symbols[EXTGLOB_PREFIX] && !(valid_symbols[VARIABLE_NAME] && is_name_start(lexer->lookahead)) &&
        !is_word_break(lexer->lookahead)) {
        return scan_extglob_prefix(lexer, valid_symbols[EMPTY_VALUE]);
    }

    if (valid_symbols[VARIABLE_NAME] && is_name_start(lexer->lookahead)) {
        return scan_name_or_extglob_prefix(lexer, valid_symbols);
    }

    if (valid_symbols[BARE_DOLLAR] && lexer->lookahead == '$') {
        advance(lexer);
        lexer->mark_end(lexer);
        int32_t c = lexer->lookahead;
        lexer->result_symbol = BARE_DOLLAR;
        return lexer->eof(lexer) || !(starts_quoted_expansion(c) || c == '\'' || c == '"');
    }

    // Bash reads a reserved word right after a compound command without a separator (`if (x) then`,
    // `{ (y) }`), so a zero-width terminator is returned before one there. After a word, the reserved
    // word would be an argument instead; a possible concatenation shows that a word just ended. This
    // check comes last because it consumes input even when it finds no reserved word.
    if (valid_symbols[NEWLINE] && !valid_symbols[CONCAT] && at_closing_reserved_word(lexer)) {
        lexer->result_symbol = NEWLINE;
        return true;
    }

    return false;
}

void *tree_sitter_bash_external_scanner_create(void) {
    Scanner *scanner = ts_calloc(1, sizeof(Scanner));
    array_init(&scanner->heredocs);
    array_init(&scanner->closers);
    return scanner;
}

void tree_sitter_bash_external_scanner_destroy(void *payload) {
    Scanner *scanner = (Scanner *)payload;
    scanner_reset(scanner);
    array_delete(&scanner->heredocs);
    array_delete(&scanner->closers);
    ts_free(scanner);
}

bool tree_sitter_bash_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    return scan((Scanner *)payload, lexer, valid_symbols);
}

unsigned tree_sitter_bash_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    unsigned size = 0;
    buffer[size++] = (char)scanner->backtick_depth;
    buffer[size++] = (char)scanner->terminator_owed;
    uint16_t closer_count = (uint16_t)scanner->closers.size;
    memcpy(&buffer[size], &closer_count, sizeof(closer_count));
    size += sizeof(closer_count);
    if (scanner->closers.size > 0) {
        memcpy(&buffer[size], scanner->closers.contents, scanner->closers.size);
        size += scanner->closers.size;
    }
    buffer[size++] = (char)scanner->heredocs.size;
    for (uint32_t i = 0; i < scanner->heredocs.size; i++) {
        Heredoc *heredoc = array_get(&scanner->heredocs, i);
        buffer[size++] = (char)heredoc->is_raw;
        buffer[size++] = (char)heredoc->allows_indent;
        buffer[size++] = (char)heredoc->started;
        memcpy(&buffer[size], &heredoc->depth, sizeof(heredoc->depth));
        size += sizeof(heredoc->depth);
        uint16_t length = (uint16_t)heredoc->delimiter.size;
        memcpy(&buffer[size], &length, sizeof(length));
        size += sizeof(length);
        for (uint32_t j = 0; j < heredoc->delimiter.size; j++) {
            size += encode_varint(*array_get(&heredoc->delimiter, j), &buffer[size]);
        }
    }
    return size;
}

void tree_sitter_bash_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    scanner_reset(scanner);
    if (length < 2 + sizeof(uint16_t)) {
        return;
    }
    unsigned size = 0;
    scanner->backtick_depth = (uint8_t)buffer[size++];
    scanner->terminator_owed = buffer[size++];
    uint16_t closer_count;
    memcpy(&closer_count, &buffer[size], sizeof(closer_count));
    size += sizeof(closer_count);
    if (size + closer_count >= length) {
        return;
    }
    array_reserve(&scanner->closers, closer_count);
    memcpy(scanner->closers.contents, &buffer[size], closer_count);
    scanner->closers.size = closer_count;
    size += closer_count;
    uint8_t count = (uint8_t)buffer[size++];
    for (uint8_t i = 0; i < count && size + HEREDOC_HEADER_SIZE <= length; i++) {
        Heredoc heredoc = {.delimiter = array_new()};
        heredoc.is_raw = buffer[size++];
        heredoc.allows_indent = buffer[size++];
        heredoc.started = buffer[size++];
        memcpy(&heredoc.depth, &buffer[size], sizeof(heredoc.depth));
        size += sizeof(heredoc.depth);
        uint16_t delimiter_length;
        memcpy(&delimiter_length, &buffer[size], sizeof(delimiter_length));
        size += sizeof(delimiter_length);
        array_reserve(&heredoc.delimiter, delimiter_length);
        for (uint16_t j = 0; j < delimiter_length; j++) {
            int32_t c;
            unsigned consumed = decode_varint(&buffer[size], length - size, &c);
            if (consumed == 0) {
                break;
            }
            size += consumed;
            array_push(&heredoc.delimiter, c);
        }
        array_push(&scanner->heredocs, heredoc);
    }
}
