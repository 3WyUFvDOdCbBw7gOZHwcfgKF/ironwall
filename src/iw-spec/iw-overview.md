# Ironwall Overview

Ironwall is a strongly typed, safety-first language designed for explicit boundaries, predictable runtime behavior, and low implementation complexity. Its design favors clear rules over language magic, auditable runtime costs over hidden mechanisms, and direct failure over recovery machinery that can hide broken invariants.

Ironwall is intended to compile to native targets while keeping the core language model compact and inspectable. It accepts only a limited set of abstractions that improve practical expression without turning the language into a hard-to-audit system.

## Key Features

- Compile to native targets
- Strong, explicit typing
- Mainly nominal types
- Higher-order functions
- Union types with exhaustive `match`
- Simple generics with explicit instantiation
- Mandatory garbage collection
- Explicitly triggered Stop-The-World GC
- No macros
- No `null`
- No type aliases
- No inheritance
- No language-level exceptions

## Design Summary

Ironwall keeps the language surface deliberately simple. Bindings, function parameters, return types, properties, globals, and generic instantiations are explicit. Classes form nominal types, generic instances remain nominal, and assignability is conservative.

Recoverable uncertainty should be modeled with data, especially `union` and `match`, rather than with `null` or exceptions. Unrecoverable violations such as illegal tags, failed preconditions, and out-of-bounds access fail immediately.

The runtime design is equally explicit. GC is mandatory for memory safety, but collection is not hidden behind background heuristics. Ironwall uses a simple Stop-The-World Mark-Sweep direction, and collection must be triggered explicitly by the program or host interface.
