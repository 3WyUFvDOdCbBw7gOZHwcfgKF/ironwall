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
