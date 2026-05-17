# Ironwall Runtime Specification

This document defines Ironwall's runtime position and GC direction. It is a principles document for the runtime layer, not a description of any specific implementation plan. Content related to concrete deployment conditions is treated only as design guidance, not as a language obligation.

## 1. Runtime Constitution

The primary mission of the Ironwall runtime is not to pursue "no visible pauses", but to establish a smaller, harder, and more auditable attack surface.

Its highest-level principles are:

- Defense against RCE takes priority over performance marketing
- Complexity is attack surface
- Explicit pauses are acceptable; implicit complex protocols are not
- GC-related optimizations should prioritize improving the normal execution-time speed and safety of programs, not prioritizing shorter GC pauses

Ironwall's runtime direction is not "transparent, concurrent, incremental", but "simple, blunt, isolated".

## 2. Hardware and Resource Position

Ironwall does not treat "extremely scarce memory" as the default historical background.

Its basic judgment is:

- On modern hardware, memory redundancy should first be treated as a safety buffer, not merely as an expensive resource that must be squeezed dry
- If saving a few MB of memory turns the runtime into a more complex, more fragile, and harder-to-audit system, that is usually the wrong tradeoff

This does not mean memory can be wasted without limit. It means:

- The runtime should prefer spending space in exchange for simplicity and safety
- It should not return to a high-risk manual-management model merely to save memory on the surface

## 3. GC Direction

### 3.1 Collector type

- Use a minimal `Mark-Sweep` collector
- The collection model is: mark reachable objects, then sweep unmarked heap blocks

### 3.2 Stop-The-World

- Collection must use Stop-The-World
- Do not introduce concurrent GC, incremental GC, or generational GC
- Do not introduce read barriers, write barriers, tri-color marking protocols, or any other collection barrier protocol

### 3.3 Triggering model

- GC triggering must be manual
- The runtime must not turn GC into an implicit, background, self-directed collection mechanism
- Programs may trigger GC explicitly
- Program callers may also trigger GC explicitly

This is a hard Ironwall position, not a temporary implementation choice. The reason is direct:

- When GC happens must be predictable, observable, and auditable
- Once trigger control is handed over to implicit runtime heuristics, the timing model and safety boundary of the entire system become blurry
- Ironwall would rather accept explicit `gc_collect` than accept implicit collection that "normally stays invisible, but may cut in at any time"

## 4. Why Complex GC Is Rejected

Ironwall's position on complex GC techniques is explicit:

- Concurrent GC pushes collection protocol into the entire normal execution path
- Barriers, concurrent marking, read/write synchronization, and state-machine switching all significantly enlarge the trusted boundary
- Once collection correctness depends on more complicated race-sensitive protocols, both attack surface and audit cost rise sharply

For this reason, Ironwall does not regard "smaller pauses" as sufficient to outweigh these costs.

## 5. Explicit Collection Entry

- If the explicit collection entry is exposed as a base-lib function, it must be an ordinary function, not a syntax keyword

Its normative requirements are:

- It must be an explicit collection entry
- Once exposed as a language-visible API, code inside the program may call it
- Callers outside the program must also be able to trigger an explicit collection with equivalent semantics through the host interface
- It must not be disguised as a wrapper facade for an implicit background strategy

Ironwall's position here is hard:

- GC is not a hidden mechanism that the runtime "handles on its own"
- GC must be part of explicit control
- Both program authors and callers must be able to semantically require a clear collection step

## 6. Safety Boundary

The Ironwall runtime explicitly rejects the following directions:

- Basing GC correctness on complex race-sensitive protocols
- Spreading hidden safepoints and implicit barriers across the ordinary execution path
- Increasing large-scale implicit collection-state tracking just to reduce pauses
- Relaxing the overall trusted boundary for the sake of local benchmark metrics

The runtime's basic requirement is not to be "smart", but to be:

- Honest
- Auditable
- Explainable
- Clear in its failure modes

## 7. GC Metadata and Table Identity

### 7.1 per-unit metadata tables

- In implementations that support separate-file compilation, each source unit may independently produce its own GC metadata table and global-var table
- A metadata table is not something that must semantically be flattened into a single program-wide table; compilation-unit boundaries are part of runtime-visible identity
- Each metadata table must carry a deterministic UUID
- Each heap object, shadow frame, and metadata entry corresponding to a global aggregate must also carry a deterministic struct UUID
- The purpose of this UUID is to identify "which metadata table this belongs to", not to replace the concrete layout tag

### 7.2 validation keys for tagged blocks

- Heap objects, shadow frames, and global aggregate blocks with GC shape must all carry three 64-bit tags in their GC-visible prefix: `tag1`, `tag2`, `tag3`
- The upper 48 bits of `tag1` are an independent 48-bit hash of the struct UUID, and the lower 16 bits are a confirmation hash derived from those 48 bits; the runtime must validate those 16 bits first before treating the block as "likely a structure header"
- `tag2` is an independent 64-bit hash of the struct UUID; `tag3` is a 64-bit hash of the metadata table UUID
- During runtime validation, candidate tables must first be located using `tag1` in the metadata-table collection, then cross-table collisions must be ruled out using `tag3`; after the table is found, candidate entries must be located using `tag1`, and in-table collisions must be ruled out using `tag2`
- The runtime must not assume that `tag1` is naturally unique across all metadata tables or even within a single table; `tag2` and `tag3` are formal collision disambiguators, not optional debug fields

### 7.3 collection model

- The integrated result of separate compilation must expose a metadata-table collection and a global-var-table collection
- The collector's global-root enumeration, metadata lookup, and GC-visible block validation must all treat these two collections as their authoritative source
- Load order and internal caching order must not act as table identity or root-enumeration sources

## 8. Separate Compilation and GC

- Even if a separately compiled unit ultimately provides only part of the globals or part of the layouts, it should still preserve its own table identity rather than erasing provenance during link/integration
- The link/integration stage may collect multiple per-unit tables into a collection, but it must not delete the information of "which metadata table this belongs to" from the heap/global validation chain
- If a unit ends up with no GC-visible layout or global at all, an implementation may materialize its corresponding table as an empty table; this does not change the identity/collection model above

### 8.1 precompiled-lib packaging and unit identity

- Packaging a separately compiled module into a `.tgz` precompiled library must not rewrite the runtime identity of the units inside it
- The archive manifest and per-unit artifacts are only delivery forms; the per-unit metadata-table / global-table identity that the GC runtime actually sees must still align with the original unit boundaries
- Each packaged unit must preserve its own `metadataTableExportSymbol`, `globalTableExportSymbol`, and `runtimeInitExportSymbol`
- When the runtime/link stage initializes an imported library, it must call every linked unit's `runtimeInitExportSymbol`, first attaching that unit's tables and global blocks into the collection, and only then executing that unit's top-level init body
- Archive load order, file order inside the `.tgz`, and the expansion order of per-unit artifacts must not participate in the determination of metadata-table identity
