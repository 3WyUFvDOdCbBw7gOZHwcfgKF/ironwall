# Ironwall Builtin Boundary Specification

This document describes only the language builtins of Ironwall.

## 1. Layering Principle

Ironwall divides available capabilities into two layers:

- Language builtins: recognized directly by the compiler and part of the core semantics
- `std~...` packages: the standard library provided through ordinary top-level definitions

This boundary must remain clear:

- Builtins do not require `import`
- Names exported from `std~...` must be brought into scope through the corresponding `(import std~...)` before they can be used directly
- There is no special rule that says "because it comes from the base lib, it automatically becomes a builtin name"

## 2. Language Builtins

### 2.1 builtin generic type

The language-level builtin generic type is:

- `array`

It is written as:

```ironwall
<array T>
```

### 2.2 builtin call names

The core builtin call names are:

- `add`
- `sub`
- `mul`
- `div`
- `mod`
- `le`
- `lt`
- `ge`
- `gt`
- `eq`
- `neq`
- `not`
- `and`
- `or`
- `xor`
- `bwand`
- `bwor`
- `bwxor`
- `ls`
- `rs`
- `class_new`
- `cm_get`
- `cm_set`
- `array_new`
- `array_get`
- `array_set`
- `array_length`
- `s3_new`, `s3_get`, `s3_set`, `s3_length`
- `s4_new`, `s4_get`, `s4_set`, `s4_length`
- `s5_new`, `s5_get`, `s5_set`, `s5_length`
- `z5_new`, `z5_set`, `z5_real`, `z5_img`
- `z6_new`, `z6_set`, `z6_real`, `z6_img`
- `z7_new`, `z7_set`, `z7_real`, `z7_img`

Only the spellings above are accepted. Object primitives accept only `class_new` / `cm_get` / `cm_set`, and variable reassignment accepts only `var_set`.

### 2.3 builtin signature closure

- The numeric arithmetic builtins `add` / `sub` / `mul` / `div` / `mod` support same-type operations on `u5|u6|u7|i5|i6|i7|f5|f6|f7`, with no cross-type promotion
- The comparison builtins `le` / `lt` / `ge` / `gt` / `eq` / `neq` support same-type comparisons on `u5|u6|u7|i5|i6|i7|f5|f6|f7` and return `bool`
- The same comparison builtins also support same-type comparisons on `c3|c4|c5` and return `bool`; their semantics are defined by single code-unit / byte ordering
- `not` supports `(bool) -> bool`
- `and` / `or` / `xor` support only `bool`
- The bitwise / shift builtins `bwand` / `bwor` / `bwxor` / `ls` / `rs` support `u5|u6|u7|i5|i6|i7`, and do not support `f5|f6|f7`
- `s3_new` / `s4_new` / `s5_new` support two signatures: `(sN) -> sN` and `(i5, cN) -> sN`
- `s3_get` / `s4_get` / `s5_get` have the signature `(sN, i5) -> cN`
- `s3_set` / `s4_set` / `s5_set` have the signature `(sN, i5, cN) -> unit`
- `s3_length` / `s4_length` / `s5_length` have the signature `(sN) -> i5`
- `z5_new` / `z6_new` / `z7_new` have the signature `(zN) -> zN`
- `z5_set` / `z6_set` / `z7_set` support two signatures: `(zN, zN) -> unit` and `(zN, fN, fN) -> unit`
- `z5_real` / `z5_img` return `f5`; `z6_real` / `z6_img` return `f6`; `z7_real` / `z7_img` return `f7`
- The frontend surface sugar additionally accepts `>= 2` argument forms for `add` / `sub` / `mul` / `and` / `or`; semantically, they are lowered into a right-associative binary tree. For example, `(add a b c d)` is equivalent to `(add a (add b (add c d)))`
- The frontend surface sugar additionally accepts `>= 2` argument forms for `le` / `lt` / `ge` / `gt` / `eq`; semantically, they are expanded into a pairwise comparison chain and joined with right-associative `and`
- The variadic surface sugar above does not change the builtin core type boundary: the `0` argument form is still illegal, `not` remains a standalone unary `(bool) -> bool` builtin, and `div` / `mod` / `neq` / `xor` / `not` are not automatically included in this sugar family

### 2.4 object and array primitives

- Whether `class_new` is legal is determined by the constructor set of the target class
- `cm_get` / `cm_set` are class-object primitives, not general library APIs
- `array_new` / `array_get` / `array_set` / `array_length` are array primitives, not `std~...` package helpers
- `s3_*` / `s4_*` / `s5_*` are text primitive families, not `std~...` package helpers
- `z5_*` / `z6_*` / `z7_*` are primitive complex copy / update / projection families, not `std~...` package helpers

## 4. Visibility and Reserved Names

In the specification:

- Builtin names are global reserved top-level names
- `self` is a reserved name
- Ordinary names exported by `std~...` packages are not part of the global reserved set

This means:

- User packages must not export names such as `add`, `array_new`, `s3_new`, `z5_real`, or `self`
- Names such as `print`, `sin`, `val_to_f7`, and `bin_to_f7` exported by `std~...` are only ordinary exports reserved within their corresponding packages; they are not language builtins
