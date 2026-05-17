# Ironwall Lexical Specification

This document defines Ironwall's lexical boundary. The goal is to keep atomic shapes, syntax sugar, and name-closure rules closed and explicit, so that ambiguity is not deferred into later syntax and semantic stages.

## 1. Design Principles

- Lexical rules must be closed, predictable, and easy to diagnose statically
- The lexical stage accepts only a finite and explicit set of atomic shapes; it does not perform loose parsing that "guesses meaning from context"
- Composite names related to the module system are closed at the lexical stage itself; `~` and `@` are not left for later character-by-character recombination
- Chain forms such as `a.b.c` are only surface syntax sugar, not an independent operator category

## 2. Allowed Characters

- The set of non-whitespace characters allowed by the lexer is: ASCII letters, decimal digits, `_`, `.`, `$`, `^`, `~`, `@`, and the four bracket kinds
- Whitespace serves only as a separator and carries no semantic meaning
- Any character outside this set must be rejected directly at the lexical stage

## 3. Bracket Kinds

Ironwall distinguishes four kinds of brackets, and the lexer must preserve the bracket kind:

- Parentheses `(` `)`
- Square brackets `[` `]`
- Braces `{` `}`
- Angle brackets `<` `>`

The four bracket kinds are not interchangeable containers. Each bracket kind corresponds to a different syntax domain.

## 4. Identifier Categories

### 4.1 ordinary identifiers

- Regex: `[a-zA-Z_][a-zA-Z0-9_]*`
- Examples: `x`, `foo`, `my_var`, `_tmp`

### 4.2 package path

- Regex: `seg (~ seg)+`
- Here `seg` must be an ordinary identifier
- Examples: `a~b`, `std~time`, `test~fixtures~parser_structures`

### 4.3 package-qualified-name

- Regex: `<package-path>@<name>`
- The left side of `@` must be a complete package path
- The right side of `@` must be a single ordinary identifier
- Examples: `app~cli@main`, `std~time@timestamp`

### 4.4 typed atom

Ironwall accepts only postfix type spelling for typed atoms: `$payload^type`.

- `payload` comes first and `type` comes after
- `type` must be an ordinary identifier
- If `payload` has identifier shape, it denotes a typed database reference
- If `payload` has numeric shape, it denotes a typed numeric literal
- Examples: `$hello^s3`, `$line_break^c4`, `$42^i5`, `$3p14^f5`

### 4.5 package-qualified typed database reference

The canonical shape of a package-qualified database reference is: `<package-path>$<reference-id>^<ty>`.

- The left side must be a complete package path and may not use `@`
- `<reference-id>` must be an ordinary identifier
- The package-qualified shape is used only for database references, not for numeric literals
- Therefore `a~b~d$name^s3` is legal, while `a~b~d$3p14^f5` must be rejected directly at the lexical stage

## 5. Closure Rules for `$payload^type`

### 5.1 typed database reference

When `payload` has ordinary-identifier shape, and the whole atom does not form a legal typed numeric literal, the atom is treated as a typed database reference.

- Example: `$hello_world^s3`
- Example: `$answer_main^i5`
- Example: `a~b~d$banner_title^s3`

### 5.2 typed numeric literal

The numeric type prefixes are:

- Signed integers: `i5`, `i6`, `i7`
- Unsigned integers: `u5`, `u6`, `u7`
- Floating point: `f5`, `f6`, `f7`
- Complex numbers: `z5`, `z6`, `z7`

The digit payload rules are as follows.

#### 5.2.1 integer payload

Legal integer payload shapes:

- `0`
- Decimal positive integers, such as `42`
- Hexadecimal integers, such as `0x2A`
- Negative-integer encoding, such as `0neg332`

Constraints:

- Decimal positive integers may not have meaningless leading zeros; except for `0`, they must start with `1-9`
- `0x` must be followed by at least one hexadecimal digit
- Negative hexadecimal spellings such as `0neg0x2A` are not supported; if a negative number needs to be represented, decimal negative payload must be used
- The role of hexadecimal payload is "a literal shape aligned with a bit-level representation", not merely an alternative decimal spelling sugar
- That is, the intent of `0x2A` is to express an integer in a bit-pattern-oriented way, not to encourage treating hexadecimal and decimal as fully equivalent surface notations that can be swapped freely

#### 5.2.2 floating-point payload

Legal floating-point payload shapes:

- Use `p` in place of the decimal point, for example `3p14`
- Support finite negative floats, for example `0neg3p14`
- Scientific notation uses `ep` / `en`, for example `3p14ep23`, `3p14en20`
- Support finite negative scientific notation, for example `0neg3p14en20`
- Shapes with only an exponent and no fractional part, for example `5ep10`
- Special values: `inf`, `0neginf`, `nan`

Constraints:

- The fractional part after `p` may not be empty; `3p` is illegal and must be written as `3p0`
- The exponent part must be a non-negative decimal integer
- Finite negative floats use the `0neg` prefix

#### 5.2.3 complex payload

At the spec layer, `z5`, `z6`, and `z7` complex literals are explicitly supported.

Their strict shape is:

```text
0real<RealPart>img<ImagPart>
```

Where:

- The payload must begin with `0real`
- `img` must appear exactly once
- `RealPart` may not be omitted
- `ImagPart` may not be omitted
- Both `RealPart` and `ImagPart` must be legal real-number payloads
- Legal real-number payloads include: integers, negative integers, floating point, negative floating point, scientific notation, negative scientific notation, `inf`, `0neginf`, and `nan`
- Traditional complex spellings that mix `+`, `-`, `.`, `e`, or `i` into the payload are not allowed

Examples:

- `$0real0neg42p32img0neg3p22^z5`
- `$0real3p14img2p0^z6`
- `$0realinfimg0neginf^z7`

Illegal examples:

- `$0realimg1^z5`
- `$0real3p14^z5`
- `$3p14img2p0^z5`
- `$0real3p14img2p0img1^z5`

The semantics of a complex payload are those of a primitive complex literal, not a plain-text shorthand for calling `z*_rect`.

#### 5.2.4 deciding between typed database reference and typed numeric literal

In the general case, the two are not ambiguous:

- Database-reference payloads start with identifier-like shapes
- Numeric-literal payloads mainly start with digits or keyword-like constant shapes

Therefore, in most cases, the two paths are naturally separated by lexical form.

The one exception that must be preserved explicitly is the floating-point keyword constants:

- `inf`
- `nan`

Although these payloads start with letters, under the `f5` / `f6` / `f7` prefixes they must be classified as numeric literals first, not as database references.

That is:

- `$inf^f5` is a floating-point literal
- `$nan^f5` is a floating-point literal
- `$inf^s3` is still a database reference
- `$answer^i5` is still a database reference

#### 5.2.5 examples

Legal:

- `$0^i5`
- `$42^i5`
- `$0neg332^i5`
- `$0x2A^u5`
- `$3p14^f5`
- `$0neg3p14^f5`
- `$3p14ep23^f6`
- `$3p14en20^f7`
- `$0neg3p14en20^f5`
- `$inf^f5`
- `$0neginf^f5`
- `$nan^f5`
- `$0real0neg42p32img0neg3p22^z5`
- `$0real3p14img2p0^z6`
- `$0realinfimg0neginf^z7`
- `$hello^s3`
- `a~b~d$hello^s3`

Illegal:

- `42`
- `0p0`
- `$001^i5`
- `$0neg0x2A^i5`
- `$0realimg1^z5`
- `$3p14img2p0^z5`
- `$0real3p14img2p0img1^z5`
- `i5$42`
- `s3$hello`
- `a~b~d$3p14^f5`

Not allowed:

- Bare `42`
- Bare `3p14`
- Inferring a default numeric type from context

## 6. Expansion of Chained Surface Sugar

At the lexical level, only one chained syntax sugar form is supported, and each segment may be only one of the following two categories:

- An ordinary identifier
- A package-qualified-name, such as `a~b@c`

`$payload^ty` and `pkg$reference^ty` do not participate in any chained expansion.

### 6.1 dot chains

`a.b.c` is expanded during lexical desugaring into nested `cm_get` calls.

- `a.b.c` -> `(cm_get (cm_get a b) c)`
- `a.b.c.d` -> `(cm_get (cm_get (cm_get a b) c) d)`
- `a~b@c.d~e@f.h~i@j` -> `(cm_get (cm_get a~b@c d~e@f) h~i@j)`
- This is lexical sugar for member-read semantics; later semantic processing still follows the ordinary rules of `cm_get`
- A dot chain must be lexically one continuous raw chunk, so `a . b`, `a. b`, and `a .b` are all illegal
- A formatter may rewrite a restorable nested `cm_get` chain back into `a.b.c` without changing semantics

### 6.2 illegal chain shapes

Illegal examples:

- `a-b-c`
- `hello..world`
- `foo.-bar`
- `$hello.world^s3`

## 7. Comment Ban

- No comment syntax such as `//`, `#`, `/* */`, or `;` is defined
- When explanatory text is needed, it should be represented through typed database entries or other ordinary language data
- Comments have no privileged lexical path

## 8. Examples of Illegal Shapes

The following shapes must be rejected at the lexical stage or at a very early syntax stage:

- `a~~b`
- `a~@main`
- `a~b@c@d`
- `1abc`
- `@main`
- `a~b.iw`
- `$hello.world^s3`
- Bare numeric `42`
- `0real3p14img2p0`
- `i5$42`
- `a~b~d$3p14^f5`

## 9. Lexical Boundary

- Bracket kinds must be preserved lexically
- Package paths, package-qualified-names, and typed references are each closed into a single atom
- `a.b.c` is already expanded before entering later stages, and no chained atom remains
