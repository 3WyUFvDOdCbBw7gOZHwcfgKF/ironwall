# Ironwall C FFI 規格

本文定義 Ironwall 目前的 C FFI 規範，包括 Ironwall 調用 C、C 調用 Ironwall、允許跨邊界傳遞的型別與命名規則。

## 1. 立場

Ironwall 不鼓勵 FFI。

FFI 是暫時的妥協，不是 Ironwall 的理想邊界。原因很直接：

- C 語言沒有 Ironwall 想要提供的記憶體安全與型別安全保證。
- C 程式可以越界讀寫、懸空指標、破壞 runtime heap、破壞 GC metadata、錯誤釋放記憶體。
- 一旦進入 C，Ironwall 的安全模型只能把 C 視為受信任但不安全的外部世界。

因此：

- FFI 只應用於必要的系統邊界、既有 C library、平台 syscall 包裝、過渡期 runtime glue。
- 不應把 FFI 當成常規抽象機制。
- 不應用 FFI 繞過 Ironwall 型別系統、GC、安全邊界或模組規則。
- C 端 bug 視為可破壞整個程序的 bug，不視為 Ironwall 可以完整隔離的普通錯誤。

FFI 的存在是工程現實，不是語言方向。Ironwall 長期方向應是減少 FFI 面積，而不是擴大它。

## 2. 核心模型

C FFI 分成兩個方向：

- Ironwall 調用 C：在 Ironwall 裡用 `declare` 宣告外部 C 函數。
- C 調用 Ironwall：把符合命名規則的 Ironwall 函數導出成 C 可調用函數。

兩個方向使用不同 ABI：

- `declare ... clang ...` 是低階 runtime ABI，C 函數直接收發 `iw_value_t`。
- `iwlang` export 是 C 邊界 ABI，C 函數使用 `int64_t`、`const char *`、`char *`、array struct。

這個分裂是有意的：

- Ironwall 調用 C 時，C 被視為 runtime 內部擴展，必須懂 `iw_value_t`。
- C 調用 Ironwall 時，外部 caller 不應直接依賴 heap object layout；跨邊界值必須經由規範允許的 ABI 表示。

## 3. 命名規則

FFI symbol 必須使用帶 namespace UUID 與 confirmation tag 的完整名稱。舊式裸 C symbol 不符合規範。

### 3.1 Ironwall 調用 C 的名稱

格式：

```text
_<uuid>_clang_<function_name>_<tag1>
```

其中：

- `<uuid>` 是一段只含 ASCII 字母與數字的 namespace 字串。
- `clang` 固定表示「此 symbol 由 C 語言提供」。
- `<function_name>` 必須符合 C identifier 形狀：`[A-Za-z_][A-Za-z0-9_]*`。
- `<tag1>` 是 8 位十六進制 confirmation tag。

例：

```text
_81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
```

若 tag 與 uuid/function name 不匹配，編譯必須拒絕。

### 3.2 C 調用 Ironwall 的導出名稱

格式：

```text
_<uuid>_iwlang_<function_name>_<tag1>
```

其中：

- `iwlang` 固定表示「此 symbol 由 Ironwall 導出」。
- 其他欄位規則與 `clang` 名稱相同。

例：

```text
_4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_i5_roundtrip_bca9013a
```

### 3.3 tag 的目的

confirmation tag 不是安全密鑰，也不是權限機制。它的作用是：

- 避免手寫 symbol 時把 namespace 或 function name 寫錯還能靜默連上。
- 讓跨語言邊界的名稱有一層低成本一致性檢查。
- 防止舊式裸 symbol 混入正式 FFI 規範。

使用者可以依下列規則計算 tag，也可以使用符合此規則的命名工具生成。

### 3.4 confirmation tag 計算規則

confirmation tag 使用 64-bit FNV-1a 計算。

`hashText(input)` 定義如下：

- 初始值：`14695981039346656037`
- prime：`1099511628211`
- 對 input 的每個 UTF-16 code unit：
- `hash = hash xor code_unit`
- `hash = (hash * prime) mod 2^64`
- 最終輸出 16 位小寫十六進制字串，不足 16 位時左側補 `0`

`clang` declared C function 的 hash input：

```text
<uuid>clang<function_name>
```

`iwlang` exported Ironwall function 的 hash input：

```text
<uuid>iwlang<function_name>
```

`tag1` 是 `hashText(hash_input)` 的最後 8 個十六進制字元。

例：

```text
uuid = 81af42c9d7354eb08bfe95163c04ad20
language = clang
function_name = iw_build_json_add_seven
hash_input = 81af42c9d7354eb08bfe95163c04ad20clangiw_build_json_add_seven
hashText(hash_input) = 6d7038b4c267f2a7
tag1 = c267f2a7
```

因此完整 symbol 是：

```text
_81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
```

## 4. Ironwall 調用 C

### 4.1 Ironwall 宣告語法

Ironwall 用 `declare` 宣告 C 函數：

```ironwall
(declare
  (function _81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
    ([value i5])
    to i5))
```

使用時和普通函數一樣：

```ironwall
{program app@main
  (declare
    (function _81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
      ([value i5])
      to i5))

  (function main ([args <array s3>]) to i5 in
    (_81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7 $35^i5))
}
```

### 4.2 C 端函數簽名

`declare` 的 C ABI 目前是 `iw_value_t` ABI。C 函數必須直接收發 `iw_value_t`：

```c
#include <stdint.h>

typedef intptr_t iw_value_t;

static inline int64_t iw_as_i64(iw_value_t value) {
    return ((int64_t)value) >> 1;
}

static inline iw_value_t iw_from_i64(int64_t value) {
    return (iw_value_t)(intptr_t)((((uint64_t)value) << 1) | 1ULL);
}

iw_value_t _81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7(iw_value_t value) {
    int32_t raw = (int32_t)iw_as_i64(value);
    uint32_t wrapped = ((uint32_t)raw) + 7u;
    return iw_from_i64((int64_t)(int32_t)wrapped);
}
```

注意：`iw_value_t` 的 `iw_as_i64` / `iw_from_i64` 是 tagged immediate 的承載格式，不是所有整數型別的語義位寬。`i5` 的語義位寬是 32-bit；declared C 函數若把 `i5` 當原生數值使用，必須在 C 端顯式轉成 `int32_t` 後再運算。

### 4.3 `unit` 返回值

Ironwall 的 `unit` 在 C ABI 中仍以 `iw_value_t` 表示。C 端應返回 `iw_from_i64(0)`：

```ironwall
(declare
  (function _5e8f0a4c71d24b6fa39ce2158bd7f043_clang_iw_sys_fd_close_a14b05cf
    ([fd i5])
    to unit))
```

```c
iw_value_t _5e8f0a4c71d24b6fa39ce2158bd7f043_clang_iw_sys_fd_close_a14b05cf(iw_value_t raw_fd) {
    int fd = (int)iw_as_i64(raw_fd);
    close(fd);
    return iw_from_i64(0);
}
```

### 4.4 C 端建立 heap 值

declared C 函數若要返回 Ironwall heap 值，不得手動配置或偽造 heap object，必須使用 declared C ABI 提供的邊界函數。

允許 C 端建立的公開 heap 值包括：

- `s3`
- `<array i5>`
- `<array s3>`

declared C ABI 必須提供以下操作：

```c
iw_value_t iw_make_s3(const char *data);
iw_value_t iw_make_array_i5(int64_t length);
iw_value_t iw_make_array_s3(int64_t length);

int32_t iw_array_i5_get(iw_value_t value, int64_t index);
void iw_array_i5_set(iw_value_t value, int64_t index, int32_t element_value);
int64_t iw_array_i5_length(iw_value_t value);

iw_value_t iw_array_s3_get(iw_value_t value, int64_t index);
void iw_array_s3_set(iw_value_t value, int64_t index, iw_value_t element_value);
int64_t iw_array_s3_length(iw_value_t value);
```

規則：

- `iw_make_s3` 必須把 C 字串內容拷貝成 Ironwall `s3`；C 端傳入的 buffer 在函數返回後不再被 Ironwall 依賴。
- `iw_make_array_i5` / `iw_make_array_s3` 建立固定長度 Ironwall array。
- array `get` / `set` 必須遵守 Ironwall array bounds 規則；越界是不可恢復運行時失敗。
- `iw_array_s3_set` 的 element value 必須是合法 Ironwall `s3` 值，通常由 `iw_make_s3` 建立。
- C 不得保存這些函數返回的 `iw_value_t` 作為跨調用長期狀態。

例：

```ironwall
{program app@main
  (declare
    (function _9a4c2e1f6b7d8c0a1234567890abcdef_clang_iw_ffi_make_array_i5_dfb65f00
      ()
      to <array i5>))

  (function main ([args <array s3>]) to i5 in
    (array_get (_9a4c2e1f6b7d8c0a1234567890abcdef_clang_iw_ffi_make_array_i5_dfb65f00) $0^i5))
}
```

```c
iw_value_t _9a4c2e1f6b7d8c0a1234567890abcdef_clang_iw_ffi_make_array_i5_dfb65f00(void) {
    iw_value_t value = iw_make_array_i5(3);
    iw_array_i5_set(value, 0, 7);
    iw_array_i5_set(value, 1, 11);
    iw_array_i5_set(value, 2, 13);
    return value;
}
```

### 4.5 declared C 的可傳型別

目前 `declare ... clang ...` 方向允許使用 Ironwall 普通函數型別中的值型別，但正式、可移植、建議使用的集合是：

- `unit`
- `bool`
- `i5`
- `i6`
- `i7`
- `u5`
- `u6`
- `u7`
- `f5`
- `f6`
- `f7`
- `c3`
- `c4`
- `c5`
- `s3`
- `s4`
- `s5`
- `z5`
- `z6`
- `z7`
- `<array i5>`
- `<array s3>`

其中：

- 所有值在 declared C ABI 上都以 `iw_value_t` 進出。
- integer、unsigned、bool、unit 是 immediate `iw_value_t`。
- float、text、complex、array 是 heap/reference `iw_value_t`。
- `<array i5>` 與 `<array s3>` 有穩定邊界操作。
- 其他 heap 型別不應作為公開 C FFI API。

不建議跨 declared C 邊界傳：

- class instance
- closure
- union
- nested array
- generic class instance，除了 `<array i5>` / `<array s3>`

這些型別會把 C 綁到 Ironwall 內部 layout、GC metadata 與 runtime tag，安全性和相容性都差。

## 5. C 調用 Ironwall

### 5.1 導出方式

Ironwall 函數若要導出給 C，函數名必須使用 `iwlang` 命名規則：

```ironwall
{program app@main
  (function _4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_i5_roundtrip_bca9013a
    ([value i5])
    to i5
    in
    (add value $1^i5))
}
```

### 5.2 C 可見簽名

C 調用 Ironwall 不直接使用 declared C 的 `iw_value_t` ABI，而使用 C 邊界 ABI：

| Ironwall 型別 | C 參數型別 | C 返回型別 |
| --- | --- | --- |
| `i5` | `int32_t` | `int32_t` |
| `s3` | `const char *` | `char *` |
| `<array i5>` | `iw_c_array_i5_t` | `iw_c_array_i5_t` |
| `<array s3>` | `iw_c_array_s3_t` | `iw_c_array_s3_t` |

目前 C 調用 Ironwall 只支持上表型別。其他型別不得作為 exported IW function 的參數或返回值。

C array ABI：

```c
typedef struct iw_c_array_i5_t {
    int64_t length;
    int32_t *items;
} iw_c_array_i5_t;

typedef struct iw_c_array_s3_t {
    int64_t length;
    char **items;
} iw_c_array_s3_t;
```

### 5.3 記憶體所有權

導出函數會在 C/Ironwall 邊界做拷貝。

規則：

- C 傳入 `const char *` 時，邊界函數會把它拷貝成 Ironwall `s3`。
- C 傳入 array struct 時，邊界函數會拷貝 array 內容。
- Ironwall 返回 `s3` 時，邊界函數會配置一段 C `char *`。
- Ironwall 返回 `<array i5>` 或 `<array s3>` 時，邊界函數會配置 C array struct 內的 `items`。
- C caller 必須釋放 C 邊界返回的 heap memory。

C 邊界 ABI 必須提供對應釋放操作：

```c
void iw_c_free_s3(char *value);
void iw_c_free_array_i5(iw_c_array_i5_t value);
void iw_c_free_array_s3(iw_c_array_s3_t value);
```

## 6. GC 與安全要求

C FFI 必須遵守以下規則：

- C 不得保存未經規範允許的 Ironwall heap 指標作為長期狀態。
- C 不得手動 `free` Ironwall heap object。
- C 不得偽造 `iw_value_t` heap reference。
- C 不得修改 Ironwall heap header、runtime type tag、GC tag 或 metadata table。
- C 若建立 Ironwall heap 值，必須使用規範允許的邊界函數。
- C 若需要返回 `unit`，必須返回 `iw_from_i64(0)`。
- C 若在 exported IW function 返回 `char *` / C array 後取得所有權，必須使用對應 C 邊界釋放操作。

## 7. 不鼓勵模式

以下模式不符合 Ironwall 安全立場：

- 把大量業務邏輯寫在 C 裡，只把 Ironwall 當 glue。
- 用 C 直接操作 Ironwall class/closure/union 內部 layout。
- 用 FFI 傳裸指標、地址整數、未標記 buffer ownership。
- 把 C global state 當作 Ironwall 型別系統之外的共享可變狀態。
- 依賴未文檔化 runtime struct layout。
- 用 FFI 繞過 `unit`、array bounds、GC root、module identity 等語義規則。

若一個功能可以用 Ironwall 寫，就應優先用 Ironwall 寫。FFI 只應作為暫時跨越不安全外部世界的窄橋。
