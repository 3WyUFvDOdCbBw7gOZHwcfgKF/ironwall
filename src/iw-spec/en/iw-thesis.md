# Ironwall Design Thesis

This document is neither a syntax manual nor an implementation guide for a specific toolchain. It is a statement of Ironwall's design principles and positions. It answers not "how do I write this syntax", but "why is Ironwall designed this way".

## 1. Core Position

Ironwall's primary goal is not adding complex syntax, not the smallest possible keystroke count, and not loosening safety boundaries to squeeze out a few more benchmark points. Ironwall has three core positions:

- Safety overwhelmingly takes priority over performance rhetoric
- Reducing the chance of mistakes takes priority over adding language magic
- Reducing system complexity takes priority over chasing theoretical extreme optimization

In other words, Ironwall does not take any of the following as design assumptions: "programmers are always careful", "the compiler can foresee all runtime states", or "a more complicated system will eventually be safer".

## 2. Memory-Safety Position

### 2.1 Mandatory GC

Ironwall explicitly adopts mandatory garbage collection and treats this route as part of its memory-safety model, not as an optional runtime plugin.

The reasons are:

- Once system scale rises, the cognitive burden of manual memory management quickly becomes unmanageable
- It is not engineering-reliable to base memory safety on programmer discipline, code review, or local habits
- Introducing more complicated protocols just to avoid GC usually only moves risk from the surface into deeper layers

Therefore, Ironwall does not treat "memory safety without GC" as a language goal.

Ironwall's position on this question is not mild or tentative; it is an explicit claim:

- Static checking cannot guarantee memory safety
- The only overall scheme that can truly guarantee memory safety at both the language layer and the runtime layer is mandatory GC

This is not a matter of taste, but a judgment about the nature of the problem. Memory safety ultimately depends on real runtime object lifetimes, aliasing relations, reachability, control flow, and data state. Any claim that static checking alone can completely guarantee memory safety is, in essence, fantasy about predicting future runtime data.

Ironwall's conclusion is direct:

- Treating static analysis as the final guarantee of memory safety is essentially a form of magical thinking
- It assumes the compiler has supernatural power to fully foresee the true future runtime state during compilation
- That assumption is not credible, so it cannot serve as Ironwall's safety foundation

Static analysis can provide diagnostics, constraints, and conservative closure, but it cannot replace GC, nor can it be repackaged as "having fundamentally solved memory safety".

### 2.2 Performance is not the supreme judge of the memory model

Ironwall acknowledges that performance matters, but rejects letting performance narratives dominate memory-safety decisions.

- If a design shortens pauses only by introducing a larger trusted boundary and higher complexity, that is not progress
- `zero-cost abstraction` is not an Ironwall value promise
- Abstraction almost always has a cost; what matters is whether that cost is transparent, controllable, and auditable

Ironwall would rather accept explicit cost than hide the real price behind language marketing.

## 3. Safety-Model Position

### 3.1 Human discipline is not trusted

Ironwall's rules are not designed on the assumption that "experts will be careful", "the team will stay disciplined", or "it will be fine if everyone just pays attention".

This is not a denial of individual skill. It is an acknowledgment of the reality of large-scale systems engineering:

- People get tired
- Teams change
- Systems grow
- Context is lost

Therefore, anything that can be enforced by language rules should not be pushed back onto "discipline".

### 3.2 The boundary of static analysis

Ironwall accepts conservative, direct, and explainable static analysis, but treats it only as a supporting tool and never elevates it into the final constitution of memory safety.

Ironwall's position is:

- Static analysis can provide boundary closure and earlier diagnostics
- Static analysis cannot guarantee memory safety
- The most critical memory safety must rely on harder runtime mechanisms, not compile-time prophecy
- Problems that can be solved through a simpler model and mandatory GC should not be solved first through a more complex analysis framework

On this point, Ironwall explicitly opposes any design philosophy that builds memory safety on the belief that "if the compiler is smart enough, it can fully see through the future".

### 3.3 Fail-Fast

When the system enters a state that violates preconditions, breaks type consistency, uses illegal tags, goes out of bounds, or violates any other core invariant, Ironwall's position is to fail immediately rather than cover up the problem with language-level recovery machinery.

Therefore:

- Ironwall provides no language-level `throw` / `try` / `catch`
- Recoverable failures should be modeled with explicit data models, such as `union` / `match`
- Unrecoverable failures should terminate immediately instead of dragging the system into a more inconsistent state

## 4. Type-System Position

### 4.1 It must be a strongly typed language

Ironwall explicitly rejects dynamic typing as the core language direction.

The reason is not that "dynamic typing cannot be used to write programs", but that:

- Saving a few keystrokes early usually only postpones complexity until later
- The larger the program, the more necessary clear type boundaries become
- If the language encourages uncertainty to be deferred until runtime, debugging costs only grow higher

Therefore, Ironwall treats clear type boundaries as a basic requirement for engineering maintainability.

### 4.2 Explicit-first

Ironwall does not treat "less typing" as the first principle.

Therefore:

- Bindings must have explicit types
- Function parameters and return types must be written explicitly
- Generic instantiation must explicitly provide type parameters
- No default numeric types are provided

If type inference would blur semantics, hide choice points, or degrade error messages, then it is not a capability Ironwall wants.

### 4.3 `null` is not accepted

Ironwall rejects `null` as a general-purpose escape hatch.

Missing values should be modeled explicitly, rather than polluting every API with a special empty value that can leak through the entire system. This is also why Ironwall accepts `union` / `match`: they make "might not exist" a fact visible at the type layer rather than a hidden convention.

### 4.4 Keep necessary abstraction, do not pursue abstraction sprawl

Ironwall is not anti-abstraction, but accepts only abstractions whose costs and benefits are both clear.

Capabilities that are explicitly supported and considered worth keeping include:

- Higher-order functions
- Simple generics
- `union` and `match`

These capabilities are accepted not because they are "theoretically advanced", but because they improve expressive power and safety in practice without blowing up total system complexity.

## 5. Syntax and Readability Position

### 5.1 Simple syntax first

Ironwall explicitly prefers simple, uniform, structurally stable syntax over surface readability built out of stacked sugar layers.

Therefore:

- The core syntax uses a simple S-expression family structure
- The number of syntax forms is kept as small as possible, and bracket kinds are kept clearly separated by semantic domain
- Introducing large numbers of special-case spellings is discouraged

### 5.2 Readability may be strengthened by tools

Ironwall acknowledges that S-expression-like syntax is not always the most intuitive to read in plain text, so it delegates part of the readability work to the tooling layer, such as:

- AST visualization
- Structured editors
- Graphical syntax projection

This means Ironwall's position is:

- Keep the core language rules simple first
- Let higher-level human interfaces be strengthened by the IDE layer

## 6. Complexity Position

Ironwall deeply distrusts complexity.

It does not believe the following directions are naturally safer:

- More complicated semantic corners
- More complicated memory models
- More complicated macro systems
- More complicated concurrency guarantees
- More complicated recovery mechanisms

Ironwall's basic judgment is: the higher the complexity, the fuzzier the trusted boundary, the higher the audit cost, and the harder it becomes to locate real failures when they occur.

Therefore, if two paths can achieve similar results, Ironwall prefers the one that is:

- Smaller in rule count
- Easier to explain
- Easier to verify
- More honest to both implementers and users

## 7. Position on Macros and Metaprogramming

Ironwall completely rejects macro systems and preprocessors.

The reasons are direct:

- Macros break the principle of "what you see is what it is"
- Macros make syntax analysis, tooling, auditing, and diagnostics more complicated
- Macros often turn local convenience into global unpredictability

Ironwall does not consider that a worthwhile tradeoff.

## 8. Position on Runtime Checks

Ironwall does not reject runtime checks. On the contrary, it treats them as part of the safety model.

Therefore:

- Array access must perform bounds checks
- `if` / `while` conditions must be `bool`; integers may not be used as booleans
- Illegal tags, out-of-bounds access, and violations of core preconditions must all fail immediately

These checks are not a sign that the language is "not advanced enough". They are a sign of being honest about real risk.

## 9. Position on Concurrency

Ironwall does not take "the language automatically guarantees concurrency safety" as a design goal.

The reasons are:

- Concurrency correctness depends heavily on concrete runtime data and scheduling conditions
- If the language claims it can settle concurrency safety once and for all at the language layer, it will usually only create false expectations

Therefore, Ironwall prioritizes closing down the models of single-threaded execution, types, modules, initialization, memory, and failure before it promises concurrency semantics beyond a trustworthy scope.

## 10. Anti-goals

The following are explicitly not goals of Ironwall:

- Sacrificing boundary clarity merely to save a few keystrokes
- Relaxing the memory-safety model for the sake of performance marketing
- Introducing large numbers of special cases just for syntactic glamor
- Allowing macros and implicit behavior for the sake of abstraction freedom
- Introducing high-complexity GC protocols just to look advanced
- Turning the whole language into a hard-to-audit system for the sake of local convenience

## 11. Summary

Ironwall's design creed can be condensed into one sentence:

> Use harder language boundaries, less complexity, and more honest runtime costs in exchange for more trustworthy safety and maintainability.
