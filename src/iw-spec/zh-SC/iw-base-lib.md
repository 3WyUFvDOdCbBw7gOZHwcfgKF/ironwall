# Ironwall Base Lib 规格

本文定义 Ironwall 内建标准库的载入方式、包结构与公开 API 边界。

## 1. 总体原则

- base lib 的源单元不是特殊语法单元，也不是静态检查或生成阶段的注入片段。
- base lib 必须完整遵守 package 系统规格：规范文件名、规范 `program` header、普通 `import`、普通 export。

## 2. 载入模型

- 标准库源单元与使用者源单元一样，统一经过同一套 unit id 验证、package 汇出与静态检查流程。
- 不允许因为 unit 来自 base lib 就跳过 package 规则、保留名字规则或 overload 规则。

## 3. 包划分

内建标准包：

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

不要求存在单一汇总包 `std`。使用者若要使用标准库名字，必须像导入任何其他 package 一样，显式 `import` 对应的 `std~...` package。

## 4. 支撑型别包

### 4.1 `std~box`

`std~box` 提供最小泛型单值 wrapper：

- `<Box T>`
- `<box_unwrap T>`

`Box<T>` 的表示是普通 generic class，内含单一 `value` property，并透过 `unwrap` method 返回内部值。

### 4.2 `std~option`

`std~option` 提供最小泛型可缺值 wrapper：

- `<Option T>`
- `<option_some T>`
- `<option_none T>`
- `<option_is_some T>`
- `<option_is_none T>`
- `<option_unwrap T>`

`Option<T>` 的表示是普通 generic class，内含一个 `<union unit T>` payload。

- `is_some` / `is_none` 对 payload 做显式 union 判别。
- `unwrap` 在 `Some` 分支返回内部值，在 `None` 分支走明确的 runtime abort。

### 4.3 `std~array`

`std~array` 提供对 builtin `<array T>` 的第一层 nominal wrapper：

- `<Array T>`
- `<ArrayBuilder T>`
- `<array_new_fill T>`
- `<array_builder_new T>`
- `<array_wrap T>`
- `<Array_len T>`
- `<ArrayBuilder_len T>`
- `<Array_contains T>`
- `<Array_filter_into T>`
- `<Array_concat T>`
- `<Array_concat_into T>`
- `<Array_sorted T>`
- `<Array_reversed T>`
- `<Array_max T>`
- `<Array_min T>`

`Array<T>` 公开提供以下 method：

- `get`
- `set`
- `fill`
- `copy`
- `count`
- `index`
- `reverse`
- `sort`

`ArrayBuilder<T>` 公开提供以下 method：

- `append`
- `build`

其中：

- `count` / `index` / `Array_contains` 依赖显式 `Eq<T>` support object。
- `sort` / `Array_sorted` / `Array_max` / `Array_min` 依赖显式 `Ord<T>` support object。
- `Array_filter_into` 会单次扫描，把符合条件的值 append 到调用端管理的 `ArrayBuilder<T>`。
- `Array_concat_into` 会把一个 `Array<T>` 的所有元素 append 到调用端管理的 `ArrayBuilder<T>`。
- `Array_reversed` 回传新的 `Array<T>` snapshot，而不是 iterator/view。
- `index` 在找不到元素时走明确的 runtime abort。
- `copy` / `Array_concat` 必须在 generic 情况下稳定配置结果阵列。

### 4.4 `std~list`

`std~list` 提供对动态长度顺序容器的第一层 nominal wrapper：

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

`List<T>` 公开提供以下 method：

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

其中：

- `List<T>` 的表示是普通 generic class，内含 `items`、`seed`、`length` 三个 property；`items` 使用递归 `<union unit <ListNode T>>` 链，而不是 dynamic vector buffer。
- `get` / `set` 提供 random-access 行为。
- `append` / `insert` / `remove` / `pop` / `reverse` 透过重建递归节点链完成；`clear` 直接把 `items` 设回 `unit`。
- `count` / `index` / `remove` / `list_contains` 依赖显式 `Eq<T>` support object。
- `insert` 只接受 `0..len` 的 index，`get` / `set` / `pop` 只接受 `0..len-1` 的 index；越界时走明确的 runtime abort。
- `List.pop` 的 method 版采显式 index 形式；“pop 最后一个元素”由 top-level `list_pop(list)` helper 提供。
- `list_sorted` / `list_max` / `list_min` 依赖显式 `Ord<T>` support object；`list_reversed` 回传新的 `List<T>` snapshot。

### 4.5 `std~set`

`std~set` 提供以递归节点链表示的 mutable set wrapper：

- `<Set T>`
- `<set_new T>`
- `<set_len T>`
- `<set_contains T>`
- `<set_union T>`
- `<set_intersection T>`
- `<set_difference T>`
- `<set_symmetric_difference T>`

`Set<T>` 公开提供以下 method：

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

其中：

- `Set<T>` 的表示是普通 generic class，内含 `hash_rule`、`eq_rule` 与递归 `items` 链；不是动态阵列，也不使用 open addressing。
- 每个节点会保存 `value`、对应的 `value_hash` 与 `next`，因此 membership 先做 hash compare，再在碰撞时退回 `Eq<T>` 检查。
- `add` / `remove` / `discard` / `pop` / `clear` 与四个 `*_update` 都是原地更新；`copy` 与 `union` / `intersection` / `difference` / `symmetric_difference` 会返回新的 `Set<T>`，并维持递归节点链表示。
- `remove` 在找不到元素时走明确的 runtime abort；`discard` 在找不到元素时不做任何事；`pop` 在空 set 上也会走 runtime abort。
- `isdisjoint` / `issubset` / `issuperset` 与集合运算依赖对另一个 `Set<T>` 逐项做 membership 检查。

### 4.6 `std~dict`

`std~dict` 提供以 open-addressed slot array 表示的 mutable dict wrapper：

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

`Dict<K, V>` 公开提供以下 method：

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

其中：

- `Dict<K, V>` 的表示是普通 generic class，内含显式 `Hash<K>` / `Eq<K>` support object、key/value seed、key/value slot array、hash/state array、size/used/capacity 与插入顺序 `List<K>`。
- key slot 与 value slot 使用 `<union unit <Box T>>` 表示空槽与已占用槽；state array 使用整数状态区分 empty / occupied / tombstone。
- `dict_new` 需要 caller 提供 `Hash<K>`、`Eq<K>`、key seed 与 value seed；初始 storage 由实作固定容量建立，后续按 used/capacity 阈值 resize。
- `get` 在找不到 key 时返回 caller 提供的 fallback；`setdefault` 在缺失时插入 fallback 并返回该值。
- `pop` 在找不到 key 时走明确的 runtime abort；`popitem` 在空 dict 上也会走 runtime abort。
- `keys` / `values` / `items` 返回新的 `List` snapshot；`items` 的元素型别为 `<Pair K V>`。
- `dict_merge` 返回新 `Dict<K, V>`，right-hand dict 的同名 key 会覆盖 left-hand dict 的值。
- `dict_equals` 除 key 的 `Eq<K>` 外，还需要 caller 额外提供 `Eq<V>` support object 来比较 value。
- `dict_fold` / `dict_map_values` / `dict_map` / `dict_filter` 以显式函数值作为 step / mapper / predicate，不引入语言级 iterator 或 closure 特例。

### 4.7 `std~pair`

`std~pair` 提供最小泛型二元组 nominal wrapper：

- `<Pair K V>`
- `<pair_first K V>`
- `<pair_second K V>`

`Pair<K, V>` 的表示是普通 generic class，内含 `first` / `second` 两个 property。

### 4.8 `std~eq`

`std~eq` 提供显式等值支撑物件：

- `<Eq T>`
- `<eq_apply T>`

`Eq<T>` 内部包一个 `<to bool from T T>` comparator，并透过 `equals` method 暴露调用。

### 4.9 `std~ord`

`std~ord` 提供显式排序支撑物件：

- `<Ord T>`
- `<ord_compare T>`

`Ord<T>` 内部包一个 `<to i5 from T T>` comparator；其 `compare` method 的返回约定是负数 / 零 / 正数。

### 4.10 `std~hash`

`std~hash` 提供显式杂凑支撑物件：

- `<Hash T>`
- `<hash_apply T>`

`Hash<T>` 内部包一个 `<to i5 from T>` hasher，并透过 `hash` method 暴露调用。

## 5. `std~io`

`std~io` 提供文字输出与 flush API。

### 5.1 输出 overload

以下名字都是普通 top-level overload，不是 builtin：

- `print : s3|s4|s5 -> unit`
- `println : s3|s4|s5 -> unit`
- `print_stderr : s3|s4|s5 -> unit`
- `println_stderr : s3|s4|s5 -> unit`

### 5.2 flush

- `flush : () -> unit`
- `flusherr : () -> unit`

## 6. 平台系统包

系统边界标准包依 target platform 显式分成 `std~linux~sys` 与 `std~windows~sys`。两者都是 thin host wrapper，host call 失败时直接 runtime abort，而不是返回 errno/result object。

### 6.1 Linux (`std~linux~sys`)

`std~linux~sys` 的 public surface 分成三组：

- policy-aligned process / env / argv / time wrapper：`sys_platform_name`、`sys_process_argc`、`sys_process_argv_s3`、`sys_env_get_s3`、`sys_env_set_s3`、`sys_env_unset_s3`、`sys_process_getpid`、`sys_process_spawn_s3`、`sys_process_spawn_stdio_s3`、`sys_process_wait`、`sys_process_kill`、`sys_process_id`、`sys_process_close`、`sys_process_exit`、`sys_process_exit_group`、`sys_time_unix_ms`、`sys_time_monotonic_ms`、`sys_sleep_ms`。
- file / path / dir / stdio wrapper：`sys_file_*`、`sys_fd_*`、`sys_path_*`、`sys_dir_open_s3`、`sys_dir_read_s3`、`sys_dir_close`、`sys_stdin_handle`、`sys_stdout_handle`、`sys_stderr_handle`、`sys_pipe_create`，以及 `SysFileStat` / `sys_stat_*` accessor。
- Linux-specific fd / network / readiness / signal primitive：`sys_fd_readv_s3`、`sys_fd_writev_s3`、`sys_fd_sendfile`、`sys_fd_dup*`、`sys_fd_fcntl_*`、`sys_net_*`、`sys_epoll_*`、`sys_eventfd_*`、`sys_timerfd_*`、`sys_signalfd_*`、`sys_poll`、`sys_ppoll`、`sys_signal_*`、`sys_thread_gettid`、`sys_thread_yield`。

其中：

- `SysProcess` 是以 pid 为中心的 nominal wrapper；为了保持 cross-platform surface 一致，调用端仍应在 Linux 上配对调用 `sys_process_close()`，即使当前 Linux 实作是 no-op。
- `sys_file_*` 是较高层的 policy alias；`sys_fd_*` 仍保留给需要直接操作 fd / offset / flag 的底层代码。
- `sys_fd_pipe2()` / `sys_pipe_create()` 都返回长度为 2 的 `<array i5>`；index `0` 是 read end，index `1` 是 write end。
- `sys_fd_openat_*` 走「显式 dir fd + relative child path」模型，而不是隐式 `AT_FDCWD` helper。
- `sys_fd_fstat()` / `sys_file_stat()` / `sys_path_stat_s3()` 都返回 nominal `SysFileStat`；Linux 版本保留 `device/inode/mode/link_count/uid/gid/rdevice/size/block_size/block_count/atime_sec/mtime_sec/ctime_sec` 等字段，常见 file-type 判断应优先用 `sys_stat_is_regular` / `sys_stat_is_dir`。
- `std~linux~sys` 不把 `sys_process_fork`、`sys_process_execve_s3`、`sys_process_wait4`、`sys_thread_tgkill` 作为 public wrapper 输出；Linux runtime 仍可在内部用更底层 host primitive 实作 spawn / wait 行为。

### 6.2 Windows (`std~windows~sys`)

`std~windows~sys` 对齐同一个跨平台 policy slice，并补上 Windows 需要的 handle、event、wait 与 TCP socket wrapper：

- platform / env / argv / process / time wrapper：`sys_platform_name`、`sys_process_argc`、`sys_process_argv_s3`、`sys_env_get_s3`、`sys_env_set_s3`、`sys_env_unset_s3`、`sys_process_getpid`、`sys_process_spawn_s3`、`sys_process_spawn_stdio_s3`、`sys_process_wait`、`sys_process_kill`、`sys_process_id`、`sys_process_close`、`sys_process_exit`、`sys_process_abort`、`sys_time_unix_ms`、`sys_time_monotonic_ms`、`sys_sleep_ms`。
- file / path / dir / stdio wrapper：`sys_file_*`、`sys_fd_*`、`sys_path_*`、`sys_dir_open_s3`、`sys_dir_read_s3`、`sys_dir_close`、`sys_stdin_handle`、`sys_stdout_handle`、`sys_stderr_handle`、`sys_pipe_create`、`SysFileStat`、`sys_stat_size`、`sys_stat_is_regular`、`sys_stat_is_dir`。
- Windows network / event / wait wrapper：`sys_net_startup`、`sys_net_cleanup`、`sys_net_*`、`sys_event_create_manual`、`sys_event_create_auto`、`sys_event_set`、`sys_event_reset`、`sys_event_close`、`sys_wait_one`、`sys_wait_many`、`sys_wait_timeout_code`。
- thread identity wrapper：`sys_thread_gettid`。

其中：

- Windows 与 Linux 共用 platform/env/path/process/time 这套高层 policy model，但 `sys_process_close()` 在 Windows 会实际释放 native handle，因此跨平台代码不应省略它。
- Windows TCP wrapper 对应 Winsock lifecycle，因此需要 `sys_net_startup()` / `sys_net_cleanup()`；socket close 走 `sys_net_close()`，普通 handle/event close 走 `sys_event_close()` 或内部 handle close wrapper。
- `std~windows~sys` 不公开 Linux-only raw primitive，例如 `fork` / `execve` / `wait4` / `tgkill`，也不公开 Linux-specific `epoll` / `eventfd` / `timerfd` / `signalfd` / `poll` surface。
- 可移植代码应优先依赖两个平台共有的 policy slice；只有明确需要 Linux readiness / signal primitive 时，才应显式依赖 `std~linux~sys`。

## 7. `std~math`

`std~math` 提供浮点、复数与纯量转换 API。

### 7.1 常数

使用显式型别版本，而不是依返回型别做 overload：

- `pi_f5`, `pi_f6`, `pi_f7`
- `tau_f5`, `tau_f6`, `tau_f7`

### 7.2 浮点 API

以下名字在 `f5` / `f6` / `f7` 上形成普通 overload：

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

其中：

- `abs` / `sin` / `cos` / `sqrt` / `hypot` / `atan2` 返回同型别浮点值。
- `round` / `floor` / `ceil` / `trunc` 返回 `i5`。

### 7.3 复数 API

以下名字在 `z5` / `z6` / `z7` 上形成普通 overload：

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

### 7.4 纯量转换 API

`std~math` 把纯量转换分成两个命名族：

- `val_to_i5`, `val_to_i6`, `val_to_i7`
- `val_to_u5`, `val_to_u6`, `val_to_u7`
- `val_to_f5`, `val_to_f6`, `val_to_f7`
- `bin_to_i5`, `bin_to_i6`, `bin_to_i7`
- `bin_to_u5`, `bin_to_u6`, `bin_to_u7`
- `bin_to_f5`, `bin_to_f6`, `bin_to_f7`

所有目标族都必须对以下来源型别提供普通 overload：

- `i5`, `i6`, `i7`
- `u5`, `u6`, `u7`
- `f5`, `f6`, `f7`

此外：

- `val_to_i5`, `val_to_u5`, `bin_to_i5`, `bin_to_u5` 额外支持 `c3`, `c4`, `c5`

语义分工如下：

- `val_to_*` 走数值语义，尽量保持数值一致。
- 浮点到整数：先舍弃小数部分；如果超过目标整数宽度，就对截断后的整数结果再截掉高位。
- 整数到浮点：走普通 numeric cast，允许精度损失。
- `bin_to_*` 走二进制拷贝语义，只保留来源 representation 的低位；若目标更宽，剩余高位补 `0`。
- `c3/c4/c5 -> i5/u5` 仍采单一 code-unit / byte semantics；在这组来源/目标上，`val_to_*` 与 `bin_to_*` 的结果相同。

因此 `val_to_i5`、`val_to_u5`、`bin_to_i5`、`bin_to_u5` 各有 12 个 overload，其余每个目标族各有 9 个 overload。overload 解析只能依名字与参数型别决定，不能依返回型别决定。

## 8. `std~string`

`std~string` 提供对文字 primitive family 的第一层 nominal wrapper：

- `StringS3`
- `StringS4`
- `StringS5`
- `string_len`
- `string_contains`
- `string_concat`
- `string_repeat`
- `string_reversed`

公开提供以下 query method：

- `find`
- `count`
- `startswith`
- `endswith`

其中：

- `StringS3` / `StringS4` / `StringS5` 分别包装 `s3` / `s4` / `s5`。
- `find` / `count` / `startswith` / `endswith` / `string_contains` 以逐字 `c3/c4/c5` 比较实作，不依赖整段 `sN` equality builtin。
- `string_concat` / `string_repeat` / `string_reversed` 走 `sN_new` / `sN_set` / `sN_get` 的显式重建路径；`string_reversed` 返回反转后的新字串 snapshot，不是 iterator。
- 语义以单一 code-unit / byte 文字模型为准，不做 Unicode normalization 或 grapheme cluster 处理。
- `find` 对找不到的子字串返回 `-1`；`count` 对空 needle 采 Python 风格 `len + 1` 语义。

## 9. builtin 边界

- `std~...` packages 是普通 package，不是 builtin 名字集合的一部分。
- 它们可以包装 `declare` 的 runtime helper，也可以包装语言 primitive，但包装后暴露出的 top-level 名字仍然是普通 package export。
- 这些名字只有在本 package 或 imported package 可见时才可用。

## 10. 相容性要求

- 新的标准库演进应优先透过新增 `std~...` package 或在现有 `std~...` package 中新增普通 export 完成。
- 不应引入 synthetic `std` 注入、base lib AST 注入、或对 base lib 的特殊静态检查 / 生成分支。
