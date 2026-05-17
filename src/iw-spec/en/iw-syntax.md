# Ironwall Syntax Specification

This document describes the core syntax shapes of Ironwall. It answers only "how to write it" and does not repeat the full semantics of types and modules; those are defined separately by the type, semantics, and module specifications.

## 1. Root Structure

- Every module-mode `.iw` source unit must have exactly one root block: `{program <unit-id> ...}`
- `program` may appear only at the root and may not be nested inside other expressions
- The canonical shape of `unit-id` is `<package-path>@<unit-name>`

Example:

```ironwall
{program app~cli@main
  (function main ([args <array s3>]) to i5 in $0^i5)
}
```

## 2. Keywords

The formal specification uses the following keywords:

- `var`
- `var_set`
- `function`

Only the keywords above are accepted.

## 3. Binding Syntax

Binding positions uniformly use:

```ironwall
[name Type]
```

Rules:

- `name` must be an ordinary identifier
- `Type` must be written explicitly
- Spellings such as `[x]` and `[x _]` that omit the type are illegal

## 4. Blocks and Order

### 4.1 `{...}` block

```ironwall
{e1 e2 ... eN}
```

- Denotes a sequential-evaluation block
- Returns the value of the last expression
- An empty block is illegal

## 5. Variables and Assignment

### 5.1 `var`

```ironwall
(var [x T] expr)
```

- Creates and initializes a named binding
- `var` is used both for local variables and for top-level globals

### 5.2 `var_set`

```ironwall
(var_set x expr)
```

- Reassigns an existing binding
- Assignment to object fields does not go through `var_set`, but through the `cm_set` builtin

## 6. Functions

### 6.1 anonymous function `fn`

```ironwall
(fn ([p1 T1] [p2 T2] ...) to Ret in body)
```

- `fn` is a first-class value
- The parameter list and return type must both be written explicitly

### 6.2 named function `function`

```ironwall
(function name ([p1 T1] ...) to Ret in body)
```

- `function` must appear at the top level
- Named functions with the same name may form an overload set by parameter type

### 6.3 `declare`

```ironwall
(declare (function name ([p1 T1] ...) to Ret))
```

- Declares the signature of an external function without providing an Ironwall body
- `declare` may appear only at the top level

## 7. `let`

```ironwall
(let (([x T] e1) ([y U] e2) ...) in body)
```

- The binding list is written with double parentheses
- Every binding must carry an explicit type
- A `let` body has exactly one main expression

## 8. Conditionals and Loops

### 8.1 `if`

```ironwall
(if cond then a else b)
```

### 8.2 `while`

```ironwall
(while condition in body)
```

### 8.3 `cond`

```ironwall
(cond
  (c1 e1)
  (c2 e2)
  (else eN)
)
```

- The `else` branch must appear last

## 9. Type Syntax

### 9.1 function type

```ironwall
<to Ret from T1 T2 ...>
```

### 9.2 union type

```ironwall
<union T1 T2 ...>
```

- A union type must contain unique immediate member types
- Duplicate immediate members are rejected during type validation rather than deduplicated
- Nested union syntax is allowed and denotes a nested union member, not an expanded member list

### 9.3 generic head

```ironwall
<generic Name T1 T2 ...>
```

- This shape is used only in the header of a generic class or generic function declaration

## 10. Generic Declaration and Instantiation

### 10.1 generic function declaration

```ironwall
(function <generic id T> ([x T]) to T in x)
```

### 10.2 generic class declaration

```ironwall
(class <generic Box T>
  (property [value T])
  (constructor ([v T]) in (cm_set self value v))
)
```

### 10.3 explicit instantiation

```ironwall
<id i5>
(<id i5> $42^i5)
<Box i5>
```

- `<name T...>` denotes explicit application of type arguments to a generic name
- If it is then wrapped in an outer `(...)`, the instantiated result is being called

## 11. `match`

```ironwall
(match value
  ([x T1] body1)
  ([y T2] body2)
  ...
)
```

- Every branch begins with a typed bind

## 12. Classes

### 12.1 class declaration

```ironwall
(class Point
  (property [x i5])
  (property [y i5])
  (method sum () to i5 in (add (cm_get self x) (cm_get self y)))
  (constructor ([x0 i5] [y0 i5]) in
    {
      (cm_set self x x0)
      (cm_set self y y0)
    }
  )
)
```

### 12.2 class member clauses

- `(property [name Type])`
- `(method name ([p T] ...) to Ret in body)`
- `(constructor ([p T] ...) in body)`

## 13. Calls and Object Operations

### 13.1 ordinary calls

```ironwall
(callee arg1 arg2 ...)
```

For the following builtins, the frontend also accepts additional variadic surface sugar:

- `add` / `sub` / `mul` / `and` / `or` may be written with `>= 2` parameters; the parser lowers them into a right-associative binary tree

```ironwall
(add a b c d)
```

Equivalent to:

```ironwall
(add a (add b (add c d)))
```

- `le` / `lt` / `ge` / `gt` / `eq` may be written with `>= 2` parameters; semantically, they form a pairwise comparison chain joined by right-associative `and`

```ironwall
(le a b c d)
```

Equivalent to:

```ironwall
(and (le a b) (and (le b c) (le c d)))
```

- This is frontend sugar, not extra runtime/builtin overloads; therefore `0` and `1` parameter forms are still illegal

### 13.2 object construction

```ironwall
(class_new Point $1^i5 $2^i5)
```

### 13.3 field reads and writes

```ironwall
(cm_get obj field)
(cm_set obj field expr)
```

- Only the object primitive set `class_new` / `cm_get` / `cm_set` is accepted

Lexical sugar:

- `a.b.c` is equivalent to `(cm_get (cm_get a b) c)`
- `a.b.c.d` is equivalent to `(cm_get (cm_get (cm_get a b) c) d)`
- Every segment must be an ordinary identifier or a package-qualified-name
- `a . b`, `a. b`, and `a .b` are all illegal, because this sugar must be lexically a single raw chunk with no spaces
- `a-b-c` is not member-read syntax

## 14. Typed Literal / Reference

Typed literals and typed database references accept only the following canonical shape:

```text
$payload^type
```

Rules:

- `$42^i5`, `$3p14^f5`, and `$hello^s3` are all legal atoms
- When a package-qualified database reference is needed, it must be written as `pkg$reference^ty`
- `pkg$reference^ty` denotes only a cross-package database reference, not a numeric literal
- Therefore `a~b~d$banner^s3` is legal, but `a~b~d$3p14^f5` is illegal

If a short-name database reference is not unique within the visible package set, it must be rewritten as a package-qualified database reference.

## 15. Array Syntax

- The builtin array type is written as `<array T>`
- The related builtin call shapes are:

```ironwall
(array_new <array T> len init)
(array_get xs idx)
(array_set xs idx value)
(array_length xs)
```

## 15. import

```ironwall
(import a~b~c)
```

- `import` may appear only at the top level
- The target of `import` is a package path, not a file path
