# Ironwall Type System Specification

This document defines Ironwall's type construction, type equality, assignability, and the closure rules for generics and union types.

## 1. Primitive Types

The primitive types are:

- Signed integers: `i5`, `i6`, `i7`
- Unsigned integers: `u5`, `u6`, `u7`
- Floating point: `f5`, `f6`, `f7`
- Complex numbers: `z5`, `z6`, `z7`
- Characters: `c3`, `c4`, `c5`
- Strings: `s3`, `s4`, `s5`
- Others: `bool`, `unit`

The naming convention is "prefix letter + exponent `n`". Its design intent is that `2^n` represents a width grade; however, type equality still depends only on the type name itself.

## 2. Class Types

### 2.1 Ordinary classes

- Every top-level `class` forms a nominal type
- A class type is identified by its class name, not by structural equality

### 2.2 Generic class instances

- Explicit instantiations such as `<Pair i5 s3>` and `<Node i5>` form concrete types
- Generic class instances are still nominal types; both the type name and all type arguments must match

### 2.3 Builtin generic types

The builtin generic type is:

- `<array T>`

`array` is a builtin runtime type, not a user-defined `class`.

## 3. Function Types

Function types are written as:

```ironwall
<to Ret from T1 T2 ...>
```

Rules:

- Parameter count, parameter order, each parameter type, and the return type all participate in type equality
- Zero-argument functions are still one case of function type

## 4. Union Types

Union types are written as:

```ironwall
<union T1 T2 ...>
```

Closure rules:

- Union members are canonicalized at the type layer
- Nested unions are not flattened; a nested union remains an immediate member type
- Duplicate immediate members are a type error and must be rejected; they are not silently deduplicated
- Member order does not affect the final notion of type equality
- Every immediate member type inside a union must be unique within that union

Therefore, the following types must be considered equal:

- `<union i5 f5>`
- `<union f5 i5>`

The following type is distinct from both of the above because the nested union is preserved:

- `<union i5 <union f5 i5>>`

The following type is invalid because `i5` appears twice as an immediate member:

- `<union i5 f5 i5>`

## 5. Type Equality

### 5.1 primitive

- Two primitive types are equal only if their type names are exactly the same

### 5.2 class

- Two class types are equal only if their class names are exactly the same

### 5.3 generic class / generic function instance

- They are equal only if the generic name is the same and all type arguments are pairwise equal

### 5.4 function type

- The parameter count must be the same
- The parameter order must be the same
- The corresponding parameter types must be equal
- The return type must be equal

### 5.5 union type

- After canonicalization, the member sequence must match exactly
- Canonicalization sorts immediate members for equality, but does not flatten nested unions

## 6. Assignability

The `isAssignable` rule is intentionally conservative:

- If `actual` and `expected` are type-equal, assignment is allowed
- If `expected` is a union, and `actual` is type-equal to one of its member types, assignment is allowed
- No other implicit assignability relation is defined

This means:

- An `i5` value may be used directly as a member value of `<union i5 f5>`
- `i5` is not implicitly converted to `f5`
- `<union i5 f5>` is not implicitly narrowed to `i5`

## 7. Generics

### 7.1 Supported range

- Generic classes are supported
- Generic functions are supported
- Generic `declare` is not supported
- Type aliases are not supported

### 7.2 Explicit-first

- Generic instantiation must explicitly write out all type arguments
- The language does not provide inference that auto-fills type arguments from value arguments
- A generic function name cannot be used as a bare value; it must first be explicitly instantiated

## 8. Explicit Annotation Requirements

The following positions must all carry explicit types:

- `[name Type]` bindings
- Function parameters
- Function return types
- Class properties
- Top-level globals

Additional restrictions:

- The declared type of a top-level global must be a primitive type, or a union containing at least one primitive member
- The final value of a top-level global initializer must be a primitive payload assignable to that type

The following are not allowed:

- Omitting the type of a `let` / `var` binding
- Omitting the return type of a function
- Omitting the type of a property

## 9. Numeric Type Rules

- There is no default integer type and no default floating-point type
- Numeric literals must be written as typed literals
- There is no implicit numeric promotion such as `i5 -> f5`, `f5 -> f6`, or `i5 -> i6`
- The available signatures of arithmetic and comparison builtins are determined by the builtin specification, not filled in through implicit conversion

## 10. `unit`

- `unit` is both a primitive type and the spelling of its unique value
- `unit` is commonly used for side-effect flows, empty results, and empty branches of types such as `<union unit T>`

## 11. Type Alias Ban

- `type alias` is strictly forbidden

## 12. Overloading

- Functions are overloaded by the uniqueness of the function name and parameter list
- Generic classes and generic functions are overloaded by the uniqueness of the generic name and generic parameter count
