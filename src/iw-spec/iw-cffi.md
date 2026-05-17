# Ironwall C FFI 規格

本文定義 Ironwall 目前的 C FFI 規範，包括 Ironwall 調用 C、C 調用 Ironwall、允許跨邊界傳遞的型別、命名規則，以及具體例子。

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
- C 調用 Ironwall：把符合命名規則的 Ironwall 函數導出成 C 可調用 wrapper。

兩個方向使用不同 ABI：

- `declare ... clang ...` 是低階 runtime ABI，C 函數直接收發 `iw_value_t`。
- `iwlang` export 是 host-friendly ABI，C 函數使用 `int64_t`、`const char *`、`char *`、host array struct。

這個分裂是有意的：

- Ironwall 調用 C 時，C 被視為 runtime 內部擴展，必須懂 `iw_value_t`。
- C 調用 Ironwall 時，外部 caller 不應直接依賴 heap object layout，所以 wrapper 會做值轉換與拷貝。

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

實作應用同一套 hash 規則生成 tag；使用者不應手算 tag，應使用工具或現有 helper 生成。

### 3.4 confirmation tag 算法

confirmation tag 使用 Ironwall 當前 `hashText` 算法生成。

`hashText(input)` 定義為 64-bit FNV-1a：

- 初始值：`14695981039346656037`
- prime：`1099511628211`
- 對 input 的每個字元，按 `charCodeAt` / UTF-16 code unit 取整數值
- `hash = hash xor code_unit`
- `hash = (hash * prime) mod 2^64`
- 最終輸出 16 位小寫十六進制字串，不足 16 位左側補 `0`

`clang` declared C function 的 hash input：

```text
<uuid>clang<function_name>
```

`iwlang` exported Ironwall function 的 hash input：

```text
<uuid>iwlang<function_name>
```

`tag1` 是 `hashText(hash_input)` 的最後 8 個十六進制字元。

例如：

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

可運行的 Node.js 驗證程式：

```javascript
function hashText(input) {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function confirmationTag(uuid, language, functionName) {
  return hashText(`${uuid}${language}${functionName}`).slice(-8);
}

function declaredCFunctionName(uuid, functionName) {
  const language = "clang";
  return `_${uuid}_${language}_${functionName}_${confirmationTag(uuid, language, functionName)}`;
}

function exportedIwFunctionName(uuid, functionName) {
  const language = "iwlang";
  return `_${uuid}_${language}_${functionName}_${confirmationTag(uuid, language, functionName)}`;
}

const declaredUuid = "81af42c9d7354eb08bfe95163c04ad20";
const exportedUuid = "4a8b9c0d1e2f34567890abcdef123456";

console.log(hashText(`${declaredUuid}clangiw_build_json_add_seven`));
console.log(declaredCFunctionName(declaredUuid, "iw_build_json_add_seven"));
console.log(exportedIwFunctionName(exportedUuid, "iw_export_i5_roundtrip"));
console.log(exportedIwFunctionName(exportedUuid, "iw_export_s3_roundtrip"));
console.log(exportedIwFunctionName(exportedUuid, "iw_export_array_i5_roundtrip"));
```

期望輸出：

```text
6d7038b4c267f2a7
_81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
_4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_i5_roundtrip_bca9013a
_4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_s3_roundtrip_d247d3be
_4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_array_i5_roundtrip_f3f8886c
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

若 declared C 函數需要返回 `s3`、`<array i5>`、`<array s3>`，backend 會在需要時提供 helper：

```c
static inline iw_value_t make_iw_s3(const char *data);
static inline iw_value_t make_iw_array_i5(int64_t length);
static inline iw_value_t make_iw_array_s3(int64_t length);

static inline int32_t _iw_array_i5_get(iw_value_t raw_value, int64_t index);
static inline void _iw_array_i5_set(iw_value_t raw_value, int64_t index, int32_t element_value);
static inline int64_t _iw_array_i5_length(iw_value_t raw_value);

static inline iw_value_t _iw_array_s3_get(iw_value_t raw_value, int64_t index);
static inline void _iw_array_s3_set(iw_value_t raw_value, int64_t index, iw_value_t element_value);
static inline int64_t _iw_array_s3_length(iw_value_t raw_value);
```

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
    iw_value_t value = make_iw_array_i5(3);
    _iw_array_i5_set(value, 0, 7);
    _iw_array_i5_set(value, 1, 11);
    _iw_array_i5_set(value, 2, 13);
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
- `<array i5>` 與 `<array s3>` 有穩定 helper。
- 其他 heap 型別雖可能在 backend 內部以 `iw_value_t` 存在，但不應作為公開 C FFI API。

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

backend 會為此函數生成 C wrapper。

### 5.2 C 可見簽名

C 調用 Ironwall 不直接使用 declared C 的 `iw_value_t` ABI，而使用 host-friendly ABI：

| Ironwall 型別 | C 參數型別 | C 返回型別 |
| --- | --- | --- |
| `i5` | `int32_t` | `int32_t` |
| `s3` | `const char *` | `char *` |
| `<array i5>` | `iw_host_array_i5_t` | `iw_host_array_i5_t` |
| `<array s3>` | `iw_host_array_s3_t` | `iw_host_array_s3_t` |

目前 C 調用 Ironwall 只支持上表型別。其他型別不得作為 exported IW function 的參數或返回值。

host array ABI：

```c
typedef struct iw_host_array_i5_t {
    int64_t length;
    int32_t *items;
} iw_host_array_i5_t;

typedef struct iw_host_array_s3_t {
    int64_t length;
    char **items;
} iw_host_array_s3_t;
```

### 5.3 記憶體所有權

導出 wrapper 會在 C/Ironwall 邊界做拷貝。

規則：

- C 傳入 `const char *` 時，wrapper 會把它拷貝成 Ironwall `s3`。
- C 傳入 array struct 時，wrapper 會拷貝 array 內容。
- Ironwall 返回 `s3` 時，wrapper 會配置一段 C `char *`。
- Ironwall 返回 `<array i5>` 或 `<array s3>` 時，wrapper 會配置 C array struct 內的 `items`。
- C caller 必須釋放 wrapper 返回的 heap memory。

生成 header/runtime 會提供釋放 helper：

```c
static inline void iw_host_free_s3(char *value);
static inline void iw_host_free_array_i5(iw_host_array_i5_t value);
static inline void iw_host_free_array_s3(iw_host_array_s3_t value);
```

### 5.4 C 調用 Ironwall 例子

Ironwall：

```ironwall
{program app@main
  (function _4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_s3_roundtrip_d247d3be
    ([value s3])
    to s3
    in
    value)

  (function _4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_array_i5_roundtrip_f3f8886c
    ([values <array i5>])
    to <array i5>
    in
    values)
}
```

C：

```c
#include "ironwall-generated-ffi.h"
#include <stdio.h>

int main(void) {
    __iw_c_init_runtime();

    char *text = _4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_s3_roundtrip_d247d3be("hello");
    puts(text);
    iw_host_free_s3(text);

    int32_t storage[3] = { 1, 2, 3 };
    iw_host_array_i5_t input = { 3, storage };
    iw_host_array_i5_t output =
        _4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_array_i5_roundtrip_f3f8886c(input);

    for (int64_t index = 0; index < output.length; index += 1) {
        printf("%d\n", (int)output.items[index]);
    }
    iw_host_free_array_i5(output);
    return 0;
}
```

## 6. GC 與安全要求

C FFI 必須遵守以下規則：

- C 不得保存未經規範允許的 Ironwall heap 指標作為長期狀態。
- C 不得手動 `free` Ironwall heap object。
- C 不得偽造 `iw_value_t` heap reference。
- C 不得修改 Ironwall heap header、runtime type tag、GC tag 或 metadata table。
- C 若建立 Ironwall heap 值，必須使用 runtime/helper 函數。
- C 若需要返回 `unit`，必須返回 `iw_from_i64(0)`。
- C 若在 exported IW wrapper 返回 `char *` / host array 後取得所有權，必須使用對應 `iw_host_free_*` helper 釋放。

GC 方面：

- FFI 不改變 Ironwall 顯式 GC 的立場。
- C 端不應在未理解 thread attach/root 規則時直接操縱 GC。
- exported IW wrapper 會處理當前 thread attach 與必要 roots；C caller 不應繞過 wrapper 直接呼叫內部 lowered function。

## 7. 不鼓勵模式

以下模式不符合 Ironwall 安全立場：

- 把大量業務邏輯寫在 C 裡，只把 Ironwall 當 glue。
- 用 C 直接操作 Ironwall class/closure/union 內部 layout。
- 用 FFI 傳裸指標、地址整數、未標記 buffer ownership。
- 把 C global state 當作 Ironwall 型別系統之外的共享可變狀態。
- 依賴未文檔化 runtime struct layout。
- 用 FFI 繞過 `unit`、array bounds、GC root、module identity 等語義規則。

若一個功能可以用 Ironwall 寫，就應優先用 Ironwall 寫。FFI 只應作為暫時跨越不安全外部世界的窄橋。
