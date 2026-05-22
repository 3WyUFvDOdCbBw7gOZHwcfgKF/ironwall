# Ironwall Module System Specification

This document defines Ironwall's multi-file module semantics. The core principle is that semantic identity is determined only by unit id, and that import, package export, entry selection, and global initialization are all closed under one unified set of rules.

## 1. Core Terms

### 1.1 source unit

- A `.iw` file participating in module mode is a source unit
- The language-level identity of a source unit is determined by its file-name stem

### 1.2 package path

- A package path is formed by joining ordinary identifiers with `~`
- A package path may be either single-segment or multi-segment
- Examples: `app`, `a~b~c`

### 1.3 unit id

- The canonical unit id shape is `<package-path>@<unit-name>`
- Examples: `app@main`, `app~cli@main`

### 1.4 literal db asset

- A literal db is a package-level asset, not an anonymous JSON mapping
- One literal-db file corresponds to one database-reference bundle in a package, not to a single reference
- The canonical file-name shape is `<package-path>$<reference-bundle>.json`
- Example: `app~assets$banner.json`

## 2. File Names and `program` Header

### 2.1 canonical file name

Under multi-file module mode, the canonical file name is:

```text
<package-path>@<unit-name>.iw
```

For example:

- `a~b@date.iw`
- `std~time@timestamp.iw`
- `app@main.iw`

### 2.2 canonical header

The root of the source file must be written as:

```ironwall
{program <package-path>@<unit-name>
  ...
}
```

### 2.3 consistency constraints

Compilation must be rejected in the following cases:

- The file-name stem and the unit id in the `program` header do not match
- A single file contains more than one root `program`
- The canonical unit id is missing
- Duplicate unit ids appear in the same semantic closure

## 3. Directory Semantics

- Directories have no language-level meaning
- If two source units in different engineering locations have the same unit id and both participate in compilation, that is a same-unit-id conflict
- Directories are only an engineering organization mechanism, not part of language semantics

Literal-db files obey the same rule: semantic identity depends only on the file stem, not on the containing directory.

## 4. Top-level Structure Restrictions

Under module mode, the top level may contain only:

- `(import package-path)`
- `(export top-level-definition-or-var)`
- `class`
- `function`
- `declare`
- Generic `class`
- Generic `function`
- Top-level `var`

The following are forbidden at top level in module mode:

- Bare top-level executable expressions
- Non-top-level `import`
- Non-top-level `export`
- Non-top-level `class` / `function` / generic definitions

## 5. Packages and Exports

### 5.1 package identity

- Package identity depends only on the package-path string itself
- One package may be composed of multiple source units

### 5.2 package export set

Only named top-level definitions wrapped in `(export ...)` enter the ordinary package export set:

- `class`
- `function`
- `declare`
- Generic `class`
- Generic `function`
- Top-level globals

The `exp` in `(export exp)` may only be one of the top-level syntax nodes above: `class`, generic `class`, `function`, `declare`, generic `function`, or top-level `var`. `export` may not wrap `import`, `var_set`, `let`, `fn`, control flow, calls, literals, identifiers, or `{...}` blocks.

Top-level names not wrapped in `export` still belong to the current package and may be resolved and used by other source units in the same package, but they are not visible to other packages.

Literal-db references still form package-visible reference entries according to the literal-db file rules; they are not wrapped in `(export ...)`.

### 5.3 the special status of `main`

- Top-level `main` is a unit-local entry symbol
- `main` does not enter the ordinary package export set
- Other units may not refer to a unit's `main` as an ordinary exported symbol through `pkg@main`

## 6. `main` Rules

If a top-level `function` is named `main`, it must satisfy all of the following:

- It must not be `declare`
- It must not be generic
- It must be at the top level
- It must have exactly one parameter
- That parameter must be named `args`
- The parameter type must be `<array s3>`
- The return type must be `i5`
- At most one `main` may be defined in a single unit

A project may contain multiple entry units; if the entry is not unique, the entry unit must be selected explicitly.

## 7. `import`

### 7.1 syntax and target

```ironwall
(import a~b~c)
```

- The target of `import` is a package path, not a file path and not a unit id
- `import` may appear only at the top level

### 7.2 duplicate, missing, and unused imports

The following cases must be errors:

- Importing the same package more than once in one unit
- Importing a package that does not exist
- An import that ultimately contributes no visibility to any short-name or fully-qualified cross-package resolution

Note:

- `import` controls cross-package visibility and imports only the exact target package
- `import a~b` does not implicitly import `a~b~c` or any other child package
- A cross-package fully-qualified name such as `pkg@name` or `pkg$reference^ty` still requires `pkg` to be the exact package imported by the current unit
- Using a fully-qualified name from an imported package counts as using that import

## 8. Name Resolution

### 8.1 short-name resolution order

The resolution order for an unqualified short name is:

1. Local lexical scope
2. The current package
3. Exported names from imported packages
4. Builtin names

Once one layer uniquely matches, resolution stops and later layers are not searched.

### 8.2 current package wins first

- When the current package matches, the result must not be upgraded into ambiguity merely because an imported package has a symbol with the same name
- If multiple imported packages all match the same name, an ambiguity error must be reported

### 8.3 fully-qualified names

The fully-qualified form for a package-exported symbol is:

```text
<package-path>@<symbol-name>
```

Its meaning is:

- Directly reference a top-level name visible from some package
- Require the target package to be either the current package or an exact package imported by this unit
- It may not bypass package-export rules to access non-exported names or unit-local special cases
- Overload resolution continues only inside the same package's same-name function set

The package-qualified form of a database reference does not use `@`, but instead:

```text
<package-path>$<reference-id>^<ty>
```

Where:

- `@` is reserved for global / class / function names in package exports
- `$` is reserved for literal-db reference names
- They are different naming entry points and may not be mixed

If a short-name database reference is not unique within the visible package set, a package-qualified database reference must be used. The package in a package-qualified database reference must also be the current package or an exact package imported by this unit.

## 9. Package-level Symbol Conflicts

Ironwall adopts a single main namespace with two limited overload exceptions.

The following cases must be errors:

- Two `class` definitions with the same name in one package
- A `class` and an ordinary `function` with the same name in one package
- A `class` and a `global` with the same name in one package
- A `class` and a generic `class` with the same name in one package
- A `class` and a generic `function` with the same name in one package
- A `global` and a `function` / `declare` with the same name in one package
- A `global` and a generic `class` with the same name in one package
- A `global` and a generic `function` with the same name in one package
- A generic `class` and an ordinary `function` / `declare` with the same name in one package
- A generic `function` and an ordinary `function` / `declare` with the same name in one package
- Two generic `class` definitions in one package with the same name and the same number of type parameters
- Two generic `function` definitions in one package with the same name and the same number of type parameters
- Two ordinary functions or declares with exactly the same signature in one package

The following cases are allowed:

- Ordinary named functions in one package may form an overload set by signature
- Generic `class` declarations in one package may form an overload set by the number of type parameters under the same name
- Generic `function` declarations in one package may form an overload set by the number of type parameters under the same name
- Different packages may export the same short name

Additional rules:

- `class`, ordinary `function` / `declare`, generic `class`, generic `function`, and top-level `global` all share a single package-level main namespace
- Inside this main namespace, the names of `class`, ordinary `function` / `declare`, and top-level `global` must all be pairwise distinct
- Generic `class` and generic `function` may not reuse any of those non-generic names either
- There are only two allowed same-name cases: ordinary named functions overloaded by function signature, and generic `class` / generic `function` overloaded by type-parameter count

### 9.1 literal-db rules

A literal-db file must satisfy the following:

- The file-name stem must be `<package-path>$<reference-bundle>`
- The JSON top level must be an object
- All keys and all values must be strings
- The key of the first key-value pair does not participate in semantic analysis and may be any non-empty string
- The value of the first key-value pair must be exactly equal to the file stem, so that it aligns with the file name
- Aside from the first key-value pair, many additional pairs are expected; together they form the same db bundle
- Aside from the first key-value pair, every key must have the shape `referenceId^ty`
- Aside from the first key-value pair, every value must be a string; even numeric content must be encoded as a string first and then interpreted by the typed-reference rules
- Within the same package, all `referenceId^ty` across all db files must be globally unique

Example:

```json
{
  "this_key_is_ignored_and_only_the_value_is_checked": "app~assets$banner",
  "hello^s3": "Hello",
  "answer^i5": "42"
}
```

The following cases must be errors:

- The file-name stem and the value of the first key-value pair do not match
- Duplicate literal-db entry names appear within the same package
- Source code writes a package-qualified non-reference shape such as `a~b~d$3p14^f5`

## 10. Reserved Names

- The language builtin top-level names form a reserved set
- `self` is also a reserved name
- Ordinary names exported from `std~...` are not part of the global reserved set; they are ordinary imported-package exports
- User packages must not define top-level exports that conflict with the builtin reserved set
- User packages may define non-exported internal helpers; they must still obey the same-package main namespace conflict rules, but they are not cross-package API

## 11. Top-level Globals

### 11.1 basic rules

- A top-level `var` is treated as a global definition
- A global must have both an explicit type and an initializer
- The declared type of a global must be a primitive type, or a union containing at least one primitive member
- If the global type is a union, the payload computed by the initializer must also be a primitive payload assignable to that union
- Declaration-first / initialization-later style is not supported

### 11.2 readability and writability

- A package may read and write its own globals
- Visible globals from other packages may also be read and written
- When accessing another package through either a short name or a fully-qualified name, exact `import` is required for visibility; fully-qualified names remove short-name ambiguity but do not bypass import

### 11.3 initializer constraints

A global initializer must satisfy the following:

- The initializer must statically converge into a primitive payload at compile time
- The initializer must not read any global
- The initializer must not call ordinary functions, generic functions, or `declare`
- The initializer must not allocate heap shapes such as class / array / closure / union objects
- The initializer must not contain `while`, `match`, or any other node that cannot be guaranteed to stay inside the static-primitive subset
- If the initializer needs intermediate state, it may use only local `let` / local `var` with explicit types, and the values of those locals must also always remain primitive payloads

The static-primitive subset contains at least:

- Primitive typed literals
- Literal-db text references
- `true`, `false`, `unit`
- `if`, `cond`, `{...}` block
- Local `let` with explicit types
- Local `var` with explicit types and `var_set` on that local
- Direct pure builtin calls whose results remain primitive payloads

## 12. Global Initialization Model

- The semantic result of a top-level global initializer must already be determined at compile time
- There is no initializer read-dependency between globals; therefore no user-visible global-init dependency graph is defined
- File discovery order, directory order, and lexicographic order have no semantic force
- If a global is never read by any program fragment reachable from the entry, the compiler may omit it from the final program; this does not change language-level observable semantics

## 13. Separate Compilation Artifacts

- A source unit may be compiled independently into its own unit artifact
- If the unit contains GC-visible layouts or top-level globals, the artifact should carry that unit's own metadata table and global-var table
- The runtime identity of a metadata table must be represented by a deterministic UUID; link/integration must not identify it merely by load order
- When multiple separately compiled units are integrated, the final program must produce a metadata-table collection and a global-var-table collection
- These collections are the runtime/GC-visible link result; they preserve the identity of "which unit artifact a table belongs to" instead of flattening everything unconditionally into one table with lost provenance

### 13.1 precompiled-lib archives

- The toolchain may package a set of modules into a precompiled library archive in `.tgz` format
- An archive must at least carry:
- `manifest.json`
- Each separately compiled unit's own machine artifact
- Each separately compiled unit's own runtime-support artifact
- The archive does not carry a source bundle; a consumer's static checking of a precompiled library must rely only on the manifest signature tables rather than rereading the library source
- If a single package is split across multiple units, the archive must preserve that unit boundary too; it may not secretly flatten them into a single `library.s` and erase per-unit metadata/global-table identity

### 13.2 manifest contracts

- The `compiledUnits` field of a manifest must list, per unit:
- `unitId`
- `assemblyPath`
- `supportPath`
- `metadataTableExportSymbol`
- `globalTableExportSymbol`
- `runtimeInitExportSymbol`
- `runtimeInitExportSymbol` is responsible for attaching that unit's local metadata/global table into the collection and then executing that unit's top-level initialization body
- The manifest must carry these signature tables:
- global signatures
- class signatures
- function signatures
- generic class signatures
- generic function signatures
- All names inside those signature tables must use full package-qualified names rather than bare exported short names
- The manifest must also carry generic monomorph tables:
- generic class monomorph table
- generic function monomorph table
- The semantic key of a monomorph table is not the source-level literal `<generic ...>` form, but `<generic, normalized endtype tuple>`
- If the type arguments of a monomorph entry still contain user generic class instances, they must first be recursively normalized into endtypes before being written into the table
- The value of a monomorph table must be the real name of the concrete class/function; this name may be a monomorphized internal symbol, but it must preserve the full package-qualified name of the source generic rather than degrading into only a short export or anonymous hash
- Consumer compilation and final linking must both resolve to the same concrete class/function name

### 13.3 consuming precompiled libraries

- One or more precompiled library archives may be loaded in an ordinary compile/check/run/emit flow
- A consumer's static checking of imported classes/functions/globals from a precompiled library must rely only on the manifest signature tables; it must not require rereadable source from inside the archive
- From the consumer's perspective, generic class/function signatures from the loaded archive must be visible just like imported package exports
- When the consumer instantiates a generic class/function from a precompiled library:
- Every type argument must first be recursively reduced into an endtype
- Then the manifest monomorph table must be looked up using `<generic, normalized endtype tuple>`
- If the lookup hits, the resulting concrete name must be used
- If the lookup misses, compilation must be rejected immediately; the compiler must not silently fall back to remonomorphizing that library generic on the fly
- After consumer compilation completes, final linking must link in the archive's per-unit artifacts as well

## 14. Entry

- If there is no top-level `main`, no executable entry can be generated
- If exactly one unit defines `main`, it may be selected automatically as the entry
- If multiple units define `main`, the entry unit must be selected explicitly
