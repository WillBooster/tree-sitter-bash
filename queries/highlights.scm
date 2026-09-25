[
  (string)
  (raw_string)
  (ansi_c_string)
  (translated_string)
  (heredoc_body)
  (heredoc_start)
] @string

(regex) @string.regexp

(command_name) @function

(function_definition
  name: (word) @function)

(variable_name) @property

(special_variable_name) @variable.builtin

[
  "case"
  "coproc"
  "do"
  "done"
  "elif"
  "else"
  "esac"
  "fi"
  "for"
  "function"
  "if"
  "in"
  "select"
  "then"
  "time"
  "until"
  "while"
] @keyword

(comment) @comment

[
  (file_descriptor)
  (number)
] @number

[
  (command_substitution)
  (process_substitution)
  (expansion)
  (arithmetic_expansion)
] @embedded

(test_operator) @operator

[
  "!"
  "&&"
  "||"
  "|"
  "|&"
  ">"
  ">>"
  "<"
  "<<<"
  "&>"
  "&>>"
  "<&"
  ">&"
  ">|"
  "=~"
] @operator

((command
  argument: (word) @constant)
  (#match? @constant "^-"))
