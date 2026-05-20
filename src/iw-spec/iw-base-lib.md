# Ironwall Base Lib 規格

本文定義 Ironwall 內建標準庫的載入方式、包結構與公開 API 邊界。

## 1. 總體原則

- base lib 的源單元不是特殊語法單元，也不是靜態檢查或生成階段的注入片段。
- base lib 必須完整遵守 package 系統規格：規範文件名、規範 `program` header、普通 `import`、普通 export。

## 2. 載入模型

- 標準庫源單元與使用者源單元一樣，統一經過同一套 unit id 驗證、package 匯出與靜態檢查流程。
- 不允許因為 unit 來自 base lib 就跳過 package 規則、保留名字規則或 overload 規則。

## 3. 包劃分

內建標準包：

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

不要求存在單一彙總包 `std`。使用者若要使用標準庫名字，必須像導入任何其他 package 一樣，顯式 `import` 對應的 `std~...` package。

## 4. 支撐型別包

### 4.1 `std~box`

`std~box` 提供最小泛型單值 wrapper：

- `<Box T>`
- `<box_unwrap T>`

`Box<T>` 的表示是普通 generic class，內含單一 `value` property，並透過 `unwrap` method 返回內部值。

### 4.2 `std~option`

`std~option` 提供最小泛型可缺值 wrapper：

- `<Option T>`
- `<option_some T>`
- `<option_none T>`
- `<option_is_some T>`
- `<option_is_none T>`
- `<option_unwrap T>`

`Option<T>` 的表示是普通 generic class，內含一個 `<union unit T>` payload。

- `is_some` / `is_none` 對 payload 做顯式 union 判別。
- `unwrap` 在 `Some` 分支返回內部值，在 `None` 分支走明確的 runtime abort。

### 4.3 `std~array`

`std~array` 提供對 builtin `<array T>` 的第一層 nominal wrapper：

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

`Array<T>` 公開提供以下 method：

- `get`
- `set`
- `fill`
- `copy`
- `count`
- `index`
- `reverse`
- `sort`

其中：

- `count` / `index` / `Array_contains` 依賴顯式 `Eq<T>` support object。
- `sort` / `Array_sorted` / `Array_max` / `Array_min` 依賴顯式 `Ord<T>` support object。
- `Array_reversed` 回傳新的 `Array<T>` snapshot，而不是 iterator/view。
- `index` 在找不到元素時走明確的 runtime abort。
- `copy` / `Array_concat` 必須在 generic 情況下穩定配置結果陣列。

### 4.4 `std~list`

`std~list` 提供對動態長度順序容器的第一層 nominal wrapper：

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

`List<T>` 公開提供以下 method：

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

- `List<T>` 的表示是普通 generic class，內含 `items`、`seed`、`length` 三個 property；`items` 使用遞歸 `<union unit <ListNode T>>` 鏈，而不是 dynamic vector buffer。
- `get` / `set` 提供 random-access 行為。
- `append` / `insert` / `remove` / `pop` / `reverse` 透過重建遞歸節點鏈完成；`clear` 直接把 `items` 設回 `unit`。
- `count` / `index` / `remove` / `list_contains` 依賴顯式 `Eq<T>` support object。
- `insert` 只接受 `0..len` 的 index，`get` / `set` / `pop` 只接受 `0..len-1` 的 index；越界時走明確的 runtime abort。
- `List.pop` 的 method 版採顯式 index 形式；「pop 最後一個元素」由 top-level `list_pop(list)` helper 提供。
- `list_sorted` / `list_max` / `list_min` 依賴顯式 `Ord<T>` support object；`list_reversed` 回傳新的 `List<T>` snapshot。

### 4.5 `std~set`

`std~set` 提供以遞歸節點鏈表示的 mutable set wrapper：

- `<Set T>`
- `<set_new T>`
- `<set_len T>`
- `<set_contains T>`
- `<set_union T>`
- `<set_intersection T>`
- `<set_difference T>`
- `<set_symmetric_difference T>`

`Set<T>` 公開提供以下 method：

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

- `Set<T>` 的表示是普通 generic class，內含 `hash_rule`、`eq_rule` 與遞歸 `items` 鏈；不是動態陣列，也不使用 open addressing。
- 每個節點會保存 `value`、對應的 `value_hash` 與 `next`，因此 membership 先做 hash compare，再在碰撞時退回 `Eq<T>` 檢查。
- `add` / `remove` / `discard` / `pop` / `clear` 與四個 `*_update` 都是原地更新；`copy` 與 `union` / `intersection` / `difference` / `symmetric_difference` 會返回新的 `Set<T>`，並維持遞歸節點鏈表示。
- `remove` 在找不到元素時走明確的 runtime abort；`discard` 在找不到元素時不做任何事；`pop` 在空 set 上也會走 runtime abort。
- `isdisjoint` / `issubset` / `issuperset` 與集合運算依賴對另一個 `Set<T>` 逐項做 membership 檢查。

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

`Dict<K, V>` 公開提供以下 method：

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

- `Dict<K, V>` 的表示是普通 generic class，內含顯式 `Hash<K>` / `Eq<K>` support object、key/value seed、key/value slot array、hash/state array、size/used/capacity 與插入順序 `List<K>`。
- key slot 與 value slot 使用 `<union unit <Box T>>` 表示空槽與已佔用槽；state array 使用整數狀態區分 empty / occupied / tombstone。
- `dict_new` 需要 caller 提供 `Hash<K>`、`Eq<K>`、key seed 與 value seed；初始 storage 由實作固定容量建立，後續按 used/capacity 閾值 resize。
- `get` 在找不到 key 時返回 caller 提供的 fallback；`setdefault` 在缺失時插入 fallback 並返回該值。
- `pop` 在找不到 key 時走明確的 runtime abort；`popitem` 在空 dict 上也會走 runtime abort。
- `keys` / `values` / `items` 回傳新的 `List` snapshot；`items` 的元素型別為 `<Pair K V>`。
- `dict_merge` 返回新 `Dict<K, V>`，right-hand dict 的同名 key 會覆蓋 left-hand dict 的值。
- `dict_equals` 除 key 的 `Eq<K>` 外，還需要 caller 額外提供 `Eq<V>` support object 來比較 value。
- `dict_fold` / `dict_map_values` / `dict_map` / `dict_filter` 以顯式函數值作為 step / mapper / predicate，不引入語言級 iterator 或 closure 特例。

### 4.7 `std~pair`

`std~pair` 提供最小泛型二元組 nominal wrapper：

- `<Pair K V>`
- `<pair_first K V>`
- `<pair_second K V>`

`Pair<K, V>` 的表示是普通 generic class，內含 `first` / `second` 兩個 property。

### 4.8 `std~eq`

`std~eq` 提供顯式等值支撐物件：

- `<Eq T>`
- `<eq_apply T>`

`Eq<T>` 內部包一個 `<to bool from T T>` comparator，並透過 `equals` method 暴露呼叫。

### 4.9 `std~ord`

`std~ord` 提供顯式排序支撐物件：

- `<Ord T>`
- `<ord_compare T>`

`Ord<T>` 內部包一個 `<to i5 from T T>` comparator；其 `compare` method 的返回約定是負數 / 零 / 正數。

### 4.10 `std~hash`

`std~hash` 提供顯式雜湊支撐物件：

- `<Hash T>`
- `<hash_apply T>`

`Hash<T>` 內部包一個 `<to i5 from T>` hasher，並透過 `hash` method 暴露呼叫。

## 5. `std~io`

`std~io` 提供文字輸出與 flush API。

### 5.1 輸出 overload

以下名字都是普通 top-level overload，不是 builtin：

- `print : s3|s4|s5 -> unit`
- `println : s3|s4|s5 -> unit`
- `print_stderr : s3|s4|s5 -> unit`
- `println_stderr : s3|s4|s5 -> unit`

### 5.2 flush

- `flush : () -> unit`
- `flusherr : () -> unit`

## 6. 平台系統包

系統邊界標準包依 target platform 顯式分成 `std~linux~sys` 與 `std~windows~sys`。兩者都是 thin host wrapper，host call 失敗時直接 runtime abort，而不是回傳 errno/result object。

### 6.1 Linux (`std~linux~sys`)

`std~linux~sys` 的 public surface 分成三組：

- policy-aligned process / env / argv / time wrapper：`sys_platform_name`、`sys_process_argc`、`sys_process_argv_s3`、`sys_env_get_s3`、`sys_env_set_s3`、`sys_env_unset_s3`、`sys_process_getpid`、`sys_process_spawn_s3`、`sys_process_spawn_stdio_s3`、`sys_process_wait`、`sys_process_kill`、`sys_process_id`、`sys_process_close`、`sys_process_exit`、`sys_process_exit_group`、`sys_time_unix_ms`、`sys_time_monotonic_ms`、`sys_sleep_ms`。
- file / path / dir / stdio wrapper：`sys_file_*`、`sys_fd_*`、`sys_path_*`、`sys_dir_open_s3`、`sys_dir_read_s3`、`sys_dir_close`、`sys_stdin_handle`、`sys_stdout_handle`、`sys_stderr_handle`、`sys_pipe_create`，以及 `SysFileStat` / `sys_stat_*` accessor。
- Linux-specific fd / network / readiness / signal primitive：`sys_fd_readv_s3`、`sys_fd_writev_s3`、`sys_fd_sendfile`、`sys_fd_dup*`、`sys_fd_fcntl_*`、`sys_net_*`、`sys_epoll_*`、`sys_eventfd_*`、`sys_timerfd_*`、`sys_signalfd_*`、`sys_poll`、`sys_ppoll`、`sys_signal_*`、`sys_thread_gettid`、`sys_thread_yield`。

其中：

- `SysProcess` 是以 pid 為中心的 nominal wrapper；為了保持 cross-platform surface 一致，呼叫端仍應在 Linux 上配對呼叫 `sys_process_close()`，即使目前 Linux 實作是 no-op。
- `sys_file_*` 是較高層的 policy alias；`sys_fd_*` 仍保留給需要直接操作 fd / offset / flag 的低層程式碼。
- `sys_fd_pipe2()` / `sys_pipe_create()` 都回傳長度為 2 的 `<array i5>`；index `0` 是 read end，index `1` 是 write end。
- `sys_fd_openat_*` 走「顯式 dir fd + relative child path」模型，而不是隱式 `AT_FDCWD` helper。
- `sys_fd_fstat()` / `sys_file_stat()` / `sys_path_stat_s3()` 都回傳 nominal `SysFileStat`；Linux 版本保留 `device/inode/mode/link_count/uid/gid/rdevice/size/block_size/block_count/atime_sec/mtime_sec/ctime_sec` 等欄位，常見 file-type 判斷應優先用 `sys_stat_is_regular` / `sys_stat_is_dir`。
- `std~linux~sys` 不把 `sys_process_fork`、`sys_process_execve_s3`、`sys_process_wait4`、`sys_thread_tgkill` 作為 public wrapper 輸出；Linux runtime 仍可在內部用較低層 host primitive 實作 spawn / wait 行為。

### 6.2 Windows (`std~windows~sys`)

`std~windows~sys` 對齊同一個跨平台 policy slice，並補上 Windows 需要的 handle、event、wait 與 TCP socket wrapper：

- platform / env / argv / process / time wrapper：`sys_platform_name`、`sys_process_argc`、`sys_process_argv_s3`、`sys_env_get_s3`、`sys_env_set_s3`、`sys_env_unset_s3`、`sys_process_getpid`、`sys_process_spawn_s3`、`sys_process_spawn_stdio_s3`、`sys_process_wait`、`sys_process_kill`、`sys_process_id`、`sys_process_close`、`sys_process_exit`、`sys_process_abort`、`sys_time_unix_ms`、`sys_time_monotonic_ms`、`sys_sleep_ms`。
- file / path / dir / stdio wrapper：`sys_file_*`、`sys_fd_*`、`sys_path_*`、`sys_dir_open_s3`、`sys_dir_read_s3`、`sys_dir_close`、`sys_stdin_handle`、`sys_stdout_handle`、`sys_stderr_handle`、`sys_pipe_create`、`SysFileStat`、`sys_stat_size`、`sys_stat_is_regular`、`sys_stat_is_dir`。
- Windows network / event / wait wrapper：`sys_net_startup`、`sys_net_cleanup`、`sys_net_*`、`sys_event_create_manual`、`sys_event_create_auto`、`sys_event_set`、`sys_event_reset`、`sys_event_close`、`sys_wait_one`、`sys_wait_many`、`sys_wait_timeout_code`。
- thread identity wrapper：`sys_thread_gettid`。

其中：

- Windows 與 Linux 共用 platform/env/path/process/time 這個高層 policy model，但 `sys_process_close()` 在 Windows 會實際釋放 native handle，因此跨平台程式碼不應省略它。
- Windows TCP wrapper 對應 Winsock lifecycle，因此需要 `sys_net_startup()` / `sys_net_cleanup()`；socket close 走 `sys_net_close()`，普通 handle/event close 走 `sys_event_close()` 或內部 handle close wrapper。
- `std~windows~sys` 不公開 Linux-only raw primitive，例如 `fork` / `execve` / `wait4` / `tgkill`，也不公開 Linux-specific `epoll` / `eventfd` / `timerfd` / `signalfd` / `poll` surface。
- 可移植程式碼應優先依賴兩個平台共有的 policy slice；只有明確需要 Linux readiness / signal primitive 時，才應顯式依賴 `std~linux~sys`。

## 7. `std~math`

`std~math` 提供浮點、複數與純量轉換 API。

### 7.1 常數

使用顯式型別版本，而不是依返回型別做 overload：

- `pi_f5`, `pi_f6`, `pi_f7`
- `tau_f5`, `tau_f6`, `tau_f7`

### 7.2 浮點 API

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

- `abs` / `sin` / `cos` / `sqrt` / `hypot` / `atan2` 返回同型別浮點值。
- `round` / `floor` / `ceil` / `trunc` 返回 `i5`。

### 7.3 複數 API

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

### 7.4 純量轉換 API

`std~math` 把純量轉換分成兩個命名族：

- `val_to_i5`, `val_to_i6`, `val_to_i7`
- `val_to_u5`, `val_to_u6`, `val_to_u7`
- `val_to_f5`, `val_to_f6`, `val_to_f7`
- `bin_to_i5`, `bin_to_i6`, `bin_to_i7`
- `bin_to_u5`, `bin_to_u6`, `bin_to_u7`
- `bin_to_f5`, `bin_to_f6`, `bin_to_f7`

所有目標族都必須對以下來源型別提供普通 overload：

- `i5`, `i6`, `i7`
- `u5`, `u6`, `u7`
- `f5`, `f6`, `f7`

此外：

- `val_to_i5`, `val_to_u5`, `bin_to_i5`, `bin_to_u5` 額外支持 `c3`, `c4`, `c5`

語義分工如下：

- `val_to_*` 走數值語義，盡量保持數值一致。
- 浮點到整數：先捨棄小數部分；如果超過目標整數寬度，就對截斷後的整數結果再截掉高位。
- 整數到浮點：走普通 numeric cast，允許精度損失。
- `bin_to_*` 走二進制拷貝語義，只保留來源 representation 的低位；若目標更寬，剩餘高位補 `0`。
- `c3/c4/c5 -> i5/u5` 仍採單一 code-unit / byte semantics；在這組來源/目標上，`val_to_*` 與 `bin_to_*` 的結果相同。

因此 `val_to_i5`、`val_to_u5`、`bin_to_i5`、`bin_to_u5` 各有 12 個 overload，其餘每個目標族各有 9 個 overload。overload 解析只能依名字與參數型別決定，不能依返回型別決定。

## 8. `std~string`

`std~string` 提供對文字 primitive family 的第一層 nominal wrapper：

- `StringS3`
- `StringS4`
- `StringS5`
- `string_len`
- `string_contains`
- `string_concat`
- `string_repeat`
- `string_reversed`

公開提供以下 query method：

- `find`
- `count`
- `startswith`
- `endswith`

其中：

- `StringS3` / `StringS4` / `StringS5` 分別包裝 `s3` / `s4` / `s5`。
- `find` / `count` / `startswith` / `endswith` / `string_contains` 以逐字 `c3/c4/c5` 比較實作，不依賴整段 `sN` equality builtin。
- `string_concat` / `string_repeat` / `string_reversed` 走 `sN_new` / `sN_set` / `sN_get` 的顯式重建路徑；`string_reversed` 返回反轉後的新字串 snapshot，不是 iterator。
- 語義以單一 code-unit / byte 文字模型為準，不做 Unicode normalization 或 grapheme cluster 處理。
- `find` 對找不到的子字串返回 `-1`；`count` 對空 needle 採 Python 風格 `len + 1` 語義。

## 9. builtin 邊界

- `std~...` packages 是普通 package，不是 builtin 名字集合的一部分。
- 它們可以包裝 `declare` 的 runtime helper，也可以包裝語言 primitive，但包裝後暴露出的 top-level 名字仍然是普通 package export。
- 這些名字只有在本 package 或 imported package 可見時才可用。

## 10. 相容性要求

- 新的標準庫演進應優先透過新增 `std~...` package 或在現有 `std~...` package 中新增普通 export 完成。
- 不應引入 synthetic `std` 注入、base lib AST 注入、或對 base lib 的特殊靜態檢查 / 生成分支。
