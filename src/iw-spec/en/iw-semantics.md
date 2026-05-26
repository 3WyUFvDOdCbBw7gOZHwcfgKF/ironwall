# Ironwall Core Semantics Specification

This document describes Ironwall's core semantics, including scope, evaluation rules, mutability, the constraints on classes and arrays, and the error model.

## 1. Overall Principles

- Explicit beats implicit
- Static analyzability beats stacks of syntax sugar
- Safety and auditability beat complex implicit behavior
- The language provides no language-level exception system

## 2. Scope and Name Resolution

Inside a core expression, names are resolved in the following order:

1. Local lexical scope
2. Top-level names in the current package
3. Top-level names in imported packages, including explicitly imported `std~...` packages
4. Language builtin names

Finer package rules at the module layer are defined by the module specification.

## 3. Mutability

### 3.1 Mutable bindings

The following bindings are semantically mutable through `var_set`:

- Local variables introduced by `var`
- `let` bindings
- Top-level globals visible to the current unit

### 3.2 Immutable bindings

The following bindings are immutable:

- Parameters of `fn` / `function`
- Parameters inside class methods and constructors
- `self`

Applying `var_set` to an immutable binding must be an error.

## 4. Visibility of `let`

- `let` bindings take effect from left to right in written order
- An ordinary binding value cannot forward-reference a later ordinary binding
- If a binding value is itself an `fn`, that `fn` may participate in a local recursive function set
- Even in a locally recursive case, ordinary non-function bindings still obey the prefix-visible rule

## 5. Control Flow

### 5.1 `if`

- `cond` must be `bool`
- The `then` and `else` branch types must be equal
- Only the selected branch is evaluated

### 5.2 `while`

- `condition` must be `bool`
- The condition is checked before each iteration body runs
- The type of the whole `while` expression is always `unit`

### 5.3 `cond`

- `else` must exist and must be the last branch
- Every non-`else` condition must be `bool`
- All branch result types must be equal

### 5.4 block

- `{e1 ... eN}` is evaluated in written order
- The value of the block is the value of its last expression

## 6. Unions and `match`

### 6.1 union member lifting

- If `T` is a member of `<union ...>`, then a `T` value may be assigned directly to that union type
- A union must carry a runtime tag

### 6.2 `match`

- The matched value must be a union type
- The branch set must exhaustively cover all union member types
- The bound type in each branch must correspond to some union member
- The result types of all branch bodies must be equal
- If a union member is itself a union, the outer `match` binds that nested union value. A second `match` is required to inspect the nested union's own runtime tag and payload

If a value does not satisfy the type precondition of `match`, that is an unrecoverable failure.

## 7. Classes and Objects

### 7.1 Basic class constraints

- Every class must have constructors; multiple constructors are allowed, and they are overloaded by parameter uniqueness
- Property names must be unique within a class
- Method names must be unique within a class
- A property and a method may not share the same name
- Inheritance is not supported
- Properties and methods not marked `public` are private by default
- `(public ...)` may mark only properties and methods; constructors are public by default
- Ordinary classes and generic classes obey the same member-visibility rules

### 7.2 constructor constraints

- A constructor must initialize all properties
- A constructor must not read a property before that property has been initialized
- When a property is read indirectly through a method, the initialization-order requirement still applies

### 7.3 `self`

- `self` is automatically bound only inside methods and constructors
- `self` is an immutable binding, but its fields may be initialized or modified through `cm_set`

### 7.4 member visibility

- Outside a class, `cm_get`, member-chain sugar, and method-value access may read only public properties and methods
- Outside a class, `cm_set` may write only public properties
- Inside a class method or constructor, `self` may read and write private properties of the same class, and may read private methods of the same class
- After generic class instantiation, the instantiated class still preserves the property / method visibility of the source generic class
- External access to a private member must be rejected as a static error

## 8. Arrays

- `<array T>` is a fixed-length array
- `array_get` / `array_set` must perform bounds checks
- `array_length` returns `i5`
- If a class is batch-created by `array_new` as an element type, that class must have a zero-argument constructor, so that the array can be built through the zero-arg constructor

## 9. Top-level globals

- A top-level `var` in module mode denotes a global
- A global must have both an explicit type and an initializer
- A global type must be a primitive type, or a union containing at least one primitive member
- A global initializer must be determined by static semantics as a primitive payload
- A global initializer must not read other globals, and must not call user-defined functions, generic functions, or `declare`
- A global initializer is restricted to control flow and builtins inside the static-primitive subset
- As long as a global is visible to the current unit, that global may be read and written; short-name access must still obey import visibility rules

Finer module-level global rules are defined by the module specification.

## 10. Error Model

### 10.1 Static errors

The following are static diagnostics:

- Lexical errors
- Syntax errors
- Type errors
- Name-resolution ambiguities
- Illegal top-level structure
- Global-init cycles
- Assignment to immutable bindings

### 10.2 Runtime failures

The following are unrecoverable runtime failures:

- Array out-of-bounds access
- Invalid union tag
- Violated builtin preconditions
- Other unrecoverable failures that violate execution preconditions

### 10.3 Exception ban

- The language does not provide `throw`, `try`, or `catch`
- Recoverable failure should be modeled with unions or other explicit data models
