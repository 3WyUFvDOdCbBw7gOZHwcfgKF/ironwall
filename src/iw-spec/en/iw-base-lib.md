# Ironwall Base-Lib Specification

This document defines how Ironwall's builtin standard library is loaded, how its packages are structured, and where its public API boundary lies.

## 1. Overall Principles

- Base-lib source units are not special syntax units, and they are not injected fragments in the static-check or code-generation stages
- The base lib must fully obey the package-system specification: canonical file names, canonical `program` headers, ordinary `import`, explicit `(export ...)`, and class-member `public`

## 2. Loading Model

- Standard-library source units and user source units go through the same unit-id validation, explicit package export, class-member visibility, and static-check pipeline
- It is not allowed to skip package rules, reserved-name rules, or overload rules merely because a unit comes from the base lib

## 3. Package Split

Builtin standard packages:

- `std~box`
- `std~option`
- `std~array`
- `std~list`
- `std~set`
- `std~dict`
- `std~pair`
- `std~eq`
- `std~ord`
- `std~hash`
- `std~io`
- `std~linux~sys`
- `std~windows~sys`
- `std~math`
- `std~string`

There is no requirement that a single aggregate package `std` exist. If a user wants to use names from the standard library, they must explicitly `import` the corresponding `std~...` package just as they would import any other package.

## 4. Support-Type Packages

### 4.1 `std~box`

`std~box` provides the smallest generic single-value wrapper:

- `<Box T>`
- `<box_unwrap T>`

`Box<T>` is represented as an ordinary generic class with one `value` property and exposes the inner value through an `unwrap` method.

### 4.2 `std~option`

`std~option` provides the smallest generic maybe-value wrapper:

- `<Option T>`
- `<option_some T>`
- `<option_none T>`
- `<option_is_some T>`
- `<option_is_none T>`
- `<option_unwrap T>`

`Option<T>` is represented as an ordinary generic class containing one `<union unit T>` payload.

- `is_some` / `is_none` perform an explicit union test on the payload
- `unwrap` returns the inner value in the `Some` branch and performs an explicit runtime abort in the `None` branch

### 4.3 `std~array`

`std~array` provides the first nominal wrapper layer around builtin `<array T>`:

- `<Array T>`
- `<array_new_fill T>`
- `<array_wrap T>`
- `<Array_len T>`
- `<Array_contains T>`
- `<Array_concat T>`
- `<Array_sorted T>`
- `<Array_reversed T>`
- `<Array_max T>`
- `<Array_min T>`

`Array<T>` publicly provides the following methods:

- `get`
- `set`
- `fill`
- `copy`
- `count`
- `index`
- `reverse`
- `sort`

Where:

- `count` / `index` / `Array_contains` depend on an explicit `Eq<T>` support object
- `sort` / `Array_sorted` / `Array_max` / `Array_min` depend on an explicit `Ord<T>` support object
- `Array_reversed` returns a new `Array<T>` snapshot, not an iterator/view
- `index` performs an explicit runtime abort if the element is not found
- `copy` / `Array_concat` must stably allocate the result array in generic cases

### 4.4 `std~list`

`std~list` provides the first nominal wrapper layer around a dynamic-length ordered container:

- `<List T>`
- `<list_new T>`
- `<list_len T>`
- `<list_contains T>`
- `<list_concat T>`
- `<list_repeat T>`
- `<list_pop T>`
- `<list_sorted T>`
- `<list_reversed T>`
- `<list_max T>`
- `<list_min T>`

`List<T>` publicly provides the following methods:

- `get`
- `set`
- `append`
- `insert`
- `remove`
- `pop`
- `clear`
- `copy`
- `count`
- `index`
- `reverse`

Where:

- `List<T>` is represented as an ordinary generic class containing three properties: `items`, `seed`, and `length`; `items` uses a recursive `<union unit <ListNode T>>` chain rather than a dynamic vector buffer
- `get` / `set` provide random-access behavior
- `append` / `insert` / `remove` / `pop` / `reverse` rebuild the recursive node chain; `clear` directly resets `items` back to `unit`
- `count` / `index` / `remove` / `list_contains` depend on an explicit `Eq<T>` support object
- `insert` accepts only indices in `0..len`; `get` / `set` / `pop` accept only indices in `0..len-1`; out-of-range access performs an explicit runtime abort
- The `List.pop` method form takes an explicit index; the top-level `list_pop(list)` helper provides the "pop last element" form
- `list_sorted` / `list_max` / `list_min` depend on an explicit `Ord<T>` support object; `list_reversed` returns a new `List<T>` snapshot

### 4.5 `std~set`

`std~set` provides a mutable set wrapper represented as a recursive node chain:

- `<Set T>`
- `<set_new T>`
- `<set_len T>`
- `<set_contains T>`
- `<set_union T>`
- `<set_intersection T>`
- `<set_difference T>`
- `<set_symmetric_difference T>`

`Set<T>` publicly provides the following methods:

- `add`
- `remove`
- `discard`
- `pop`
- `clear`
- `copy`
- `union`
- `intersection`
- `difference`
- `symmetric_difference`
- `update`
- `intersection_update`
- `difference_update`
- `symmetric_difference_update`
- `isdisjoint`
- `issubset`
- `issuperset`

Where:

- `Set<T>` is represented as an ordinary generic class containing `hash_rule`, `eq_rule`, and a recursive `items` chain; it is not a dynamic array and does not use open addressing
- Every node stores `value`, its `value_hash`, and `next`, so membership first compares hashes and falls back to `Eq<T>` only on collision
- `add` / `remove` / `discard` / `pop` / `clear` and the four `*_update` methods mutate in place; `copy` and `union` / `intersection` / `difference` / `symmetric_difference` return new `Set<T>` values while preserving the recursive-node representation
- `remove` performs an explicit runtime abort when the element is not found; `discard` does nothing when it is not found; `pop` also performs a runtime abort on an empty set
- `isdisjoint` / `issubset` / `issuperset` and set operations depend on per-element membership checks against another `Set<T>`

### 4.6 `std~dict`

`std~dict` provides a mutable dict wrapper represented with open-addressed slot arrays:

- `<Dict K V>`
- `<dict_new K V>`
- `<dict_len K V>`
- `<dict_contains K V>`
- `<dict_fold K V Acc>`
- `<dict_map_values K V U>`
- `<dict_map K V U>`
- `<dict_filter K V>`
- `<dict_merge K V>`
- `<dict_equals K V>`

`Dict<K, V>` publicly provides the following methods:

- `get`
- `pop`
- `popitem`
- `update`
- `setdefault`
- `clear`
- `copy`
- `keys`
- `values`
- `items`

Where:

- `Dict<K, V>` is represented as an ordinary generic class containing explicit `Hash<K>` / `Eq<K>` support objects, key/value seeds, key/value slot arrays, hash/state arrays, size/used/capacity, and an insertion-order `List<K>`
- Key slots and value slots use `<union unit <Box T>>` to represent empty and occupied slots; the state array uses integer states to distinguish empty / occupied / tombstone
- `dict_new` requires the caller to provide `Hash<K>`, `Eq<K>`, a key seed, and a value seed; initial storage is created with an implementation-fixed capacity and later resized according to the used/capacity threshold
- `get` returns the caller-provided fallback when the key is missing; `setdefault` inserts the fallback on miss and returns that value
- `pop` performs an explicit runtime abort when the key is not found; `popitem` also performs a runtime abort on an empty dict
- `keys` / `values` / `items` return new `List` snapshots; `items` has element type `<Pair K V>`
- `dict_merge` returns a new `Dict<K, V>` where same-name keys from the right-hand dict overwrite values from the left-hand dict
- In addition to the key `Eq<K>`, `dict_equals` requires the caller to provide an extra `Eq<V>` support object for comparing values
- `dict_fold` / `dict_map_values` / `dict_map` / `dict_filter` use explicit function values as step / mapper / predicate and do not introduce language-level iterator or closure special cases

### 4.7 `std~pair`

`std~pair` provides the smallest generic two-tuple nominal wrapper:

- `<Pair K V>`
- `<pair_first K V>`
- `<pair_second K V>`

`Pair<K, V>` is represented as an ordinary generic class with two properties, `first` and `second`.

### 4.8 `std~eq`

`std~eq` provides an explicit equality support object:

- `<Eq T>`
- `<eq_apply T>`

`Eq<T>` wraps one comparator of type `<to bool from T T>` and exposes calls through the `equals` method.

### 4.9 `std~ord`

`std~ord` provides an explicit ordering support object:

- `<Ord T>`
- `<ord_compare T>`

`Ord<T>` wraps one comparator of type `<to i5 from T T>`. Its `compare` method follows the negative / zero / positive return convention.

### 4.10 `std~hash`

`std~hash` provides an explicit hashing support object:

- `<Hash T>`
- `<hash_apply T>`

`Hash<T>` wraps one hasher of type `<to i5 from T>` and exposes calls through the `hash` method.

## 5. `std~io`

`std~io` provides text output and flush APIs.

### 5.1 output overloads

The following names are ordinary top-level overloads, not builtins:

- `print : s3|s4|s5 -> unit`
- `println : s3|s4|s5 -> unit`
- `print_stderr : s3|s4|s5 -> unit`
- `println_stderr : s3|s4|s5 -> unit`

### 5.2 flush

- `flush : () -> unit`
- `flusherr : () -> unit`

## 6. Platform System Packages

System-boundary standard packages are explicit by target platform: `std~linux~sys` and `std~windows~sys`. Both are thin host-wrapper packages that abort directly on host-call failure instead of returning errno/result objects.

### 6.1 Linux (`std~linux~sys`)

The public `std~linux~sys` surface is grouped into three slices:

- policy-aligned process / env / argv / time wrappers: `sys_platform_name`, `sys_process_argc`, `sys_process_argv_s3`, `sys_env_get_s3`, `sys_env_set_s3`, `sys_env_unset_s3`, `sys_process_getpid`, `sys_process_spawn_s3`, `sys_process_spawn_stdio_s3`, `sys_process_wait`, `sys_process_kill`, `sys_process_id`, `sys_process_close`, `sys_process_exit`, `sys_process_exit_group`, `sys_time_unix_ms`, `sys_time_monotonic_ms`, `sys_sleep_ms`
- file / path / dir / stdio wrappers: `sys_file_*`, `sys_fd_*`, `sys_path_*`, `sys_dir_open_s3`, `sys_dir_read_s3`, `sys_dir_close`, `sys_stdin_handle`, `sys_stdout_handle`, `sys_stderr_handle`, `sys_pipe_create`, plus `SysFileStat` and `sys_stat_*` accessors
- Linux-specific fd / network / readiness / signal primitives: `sys_fd_readv_s3`, `sys_fd_writev_s3`, `sys_fd_sendfile`, `sys_fd_dup*`, `sys_fd_fcntl_*`, `sys_net_*`, `sys_epoll_*`, `sys_eventfd_*`, `sys_timerfd_*`, `sys_signalfd_*`, `sys_poll`, `sys_ppoll`, `sys_signal_*`, `sys_thread_gettid`, `sys_thread_yield`

Where:

- `SysProcess` is a pid-centric nominal wrapper. Callers should still pair it with `sys_process_close()` on Linux so cross-platform code keeps one symmetric lifecycle, even though the current Linux implementation is a no-op.
- `sys_file_*` is the higher-level policy alias layer; `sys_fd_*` remains available for code that explicitly wants fd / offset / flag oriented operations.
- `sys_fd_pipe2()` and `sys_pipe_create()` both return a length-2 `<array i5>` with index `0` as the read end and index `1` as the write end.
- `sys_fd_openat_*` uses an explicit `dir fd + relative child path` model rather than an implicit `AT_FDCWD` helper.
- `sys_fd_fstat()` / `sys_file_stat()` / `sys_path_stat_s3()` all produce nominal `SysFileStat` values. On Linux this structure preserves `device/inode/mode/link_count/uid/gid/rdevice/size/block_size/block_count/atime_sec/mtime_sec/ctime_sec`; common file-type checks should prefer `sys_stat_is_regular` / `sys_stat_is_dir`.
- `std~linux~sys` does not export `sys_process_fork`, `sys_process_execve_s3`, `sys_process_wait4`, or `sys_thread_tgkill` as public wrappers. The Linux runtime may still use lower-level host primitives internally to implement spawn / wait behavior.

### 6.2 Windows (`std~windows~sys`)

`std~windows~sys` follows the same cross-platform policy slice and adds the Windows-side handle, event, wait, and TCP socket wrappers:

- platform / env / argv / process / time wrappers: `sys_platform_name`, `sys_process_argc`, `sys_process_argv_s3`, `sys_env_get_s3`, `sys_env_set_s3`, `sys_env_unset_s3`, `sys_process_getpid`, `sys_process_spawn_s3`, `sys_process_spawn_stdio_s3`, `sys_process_wait`, `sys_process_kill`, `sys_process_id`, `sys_process_close`, `sys_process_exit`, `sys_process_abort`, `sys_time_unix_ms`, `sys_time_monotonic_ms`, `sys_sleep_ms`
- file / path / dir / stdio wrappers: `sys_file_*`, `sys_fd_*`, `sys_path_*`, `sys_dir_open_s3`, `sys_dir_read_s3`, `sys_dir_close`, `sys_stdin_handle`, `sys_stdout_handle`, `sys_stderr_handle`, `sys_pipe_create`, `SysFileStat`, `sys_stat_size`, `sys_stat_is_regular`, `sys_stat_is_dir`
- Windows network / event / wait wrappers: `sys_net_startup`, `sys_net_cleanup`, `sys_net_*`, `sys_event_create_manual`, `sys_event_create_auto`, `sys_event_set`, `sys_event_reset`, `sys_event_close`, `sys_wait_one`, `sys_wait_many`, `sys_wait_timeout_code`
- thread identity wrapper: `sys_thread_gettid`

Where:

- Windows shares the same high-level platform/env/path/process/time policy model, but `sys_process_close()` really closes native handles on Windows, so portable code should not omit it.
- Windows TCP wrappers follow the Winsock lifecycle, so callers use `sys_net_startup()` / `sys_net_cleanup()`; socket close goes through `sys_net_close()`, while ordinary handle/event close goes through `sys_event_close()` or the internal handle-close wrapper.
- `std~windows~sys` does not expose Linux-only raw primitives such as `fork` / `execve` / `wait4` / `tgkill`, and it does not expose Linux-specific `epoll` / `eventfd` / `timerfd` / `signalfd` / `poll` surfaces.
- Portable code should target the shared policy slice first, and depend on `std~linux~sys` explicitly only when Linux readiness / signal primitives are actually required.

## 7. `std~math`

`std~math` provides floating-point, complex-number, and scalar-conversion APIs.

### 7.1 constants

Use explicit typed variants rather than overloading on return type:

- `pi_f5`, `pi_f6`, `pi_f7`
- `tau_f5`, `tau_f6`, `tau_f7`

### 7.2 floating-point API

The following names form ordinary overloads on `f5` / `f6` / `f7`:

- `abs`
- `round`
- `floor`
- `ceil`
- `trunc`
- `sin`
- `cos`
- `sqrt`
- `hypot`
- `atan2`

Where:

- `abs` / `sin` / `cos` / `sqrt` / `hypot` / `atan2` return floating-point values of the same type
- `round` / `floor` / `ceil` / `trunc` return `i5`

### 7.3 complex-number API

The following names form ordinary overloads on `z5` / `z6` / `z7`:

- `znew`
- `zrect`
- `zreal`
- `zimg`
- `zadd`
- `zsub`
- `zmul`
- `zabs`
- `zarg`
- `zconj`
- `zproj`
- `zexp`
- `zlog`
- `zsqrt`
- `zpow`

### 7.4 scalar-conversion API

`std~math` divides scalar conversion into two naming families:

- `val_to_i5`, `val_to_i6`, `val_to_i7`
- `val_to_u5`, `val_to_u6`, `val_to_u7`
- `val_to_f5`, `val_to_f6`, `val_to_f7`
- `bin_to_i5`, `bin_to_i6`, `bin_to_i7`
- `bin_to_u5`, `bin_to_u6`, `bin_to_u7`
- `bin_to_f5`, `bin_to_f6`, `bin_to_f7`

Every target family must provide ordinary overloads for the following source types:

- `i5`, `i6`, `i7`
- `u5`, `u6`, `u7`
- `f5`, `f6`, `f7`

In addition:

- `val_to_i5`, `val_to_u5`, `bin_to_i5`, and `bin_to_u5` additionally support `c3`, `c4`, `c5`

The semantic split is:

- `val_to_*` follows numeric semantics and tries to preserve the numeric value as much as possible
- Float-to-integer conversion first discards the fractional part; if the result exceeds the target integer width, the high bits of the truncated integer are then discarded
- Integer-to-float conversion uses an ordinary numeric cast and may lose precision
- `bin_to_*` uses binary-copy semantics and retains only the low bits of the source representation; if the target is wider, the remaining high bits are zero-filled
- For `c3/c4/c5 -> i5/u5`, single code-unit / byte semantics still apply; for these source/target pairs, `val_to_*` and `bin_to_*` produce the same result

Therefore `val_to_i5`, `val_to_u5`, `bin_to_i5`, and `bin_to_u5` each have 12 overloads, while every other target family has 9 overloads. Overload resolution may depend only on name and parameter type, never on return type.

## 8. `std~string`

`std~string` provides the first nominal wrapper layer around the text primitive families:

- `StringS3`
- `StringS4`
- `StringS5`
- `string_len`
- `string_contains`
- `string_concat`
- `string_repeat`
- `string_reversed`

It publicly provides the following query methods:

- `find`
- `count`
- `startswith`
- `endswith`

Where:

- `StringS3` / `StringS4` / `StringS5` wrap `s3` / `s4` / `s5` respectively
- `find` / `count` / `startswith` / `endswith` / `string_contains` are implemented through per-character `c3/c4/c5` comparison and do not rely on whole-`sN` equality builtins
- `string_concat` / `string_repeat` / `string_reversed` use explicit reconstruction through `sN_new` / `sN_set` / `sN_get`; `string_reversed` returns a reversed snapshot string, not an iterator
- Semantics are defined by a single code-unit / byte text model; there is no Unicode normalization or grapheme-cluster handling
- `find` returns `-1` when the substring is not found; `count` follows Python-style `len + 1` semantics for an empty needle

## 9. Builtin Boundary

- `std~...` packages are ordinary packages, not part of the builtin name set
- They may wrap runtime helpers exposed through `declare`, and may wrap language primitives, but the top-level names they expose after wrapping must still enter the ordinary package export set through `(export ...)`
- These names are usable only when visible through the current package or an imported package

## 10. Compatibility Requirements

- Future standard-library evolution should happen primarily by adding new `std~...` packages or new explicit `(export ...)` entries to existing `std~...` packages
- Synthetic `std` injection, base-lib AST injection, or special static-check / codegen branches for the base lib should not be introduced
