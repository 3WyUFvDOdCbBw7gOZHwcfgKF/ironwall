# Ironwall C FFI 规格

本文定义 Ironwall 目前的 C FFI 规范，包括 Ironwall 调用 C、C 调用 Ironwall、允许跨边界传递的型别、命名规则，以及具体例子。

## 1. 立场

Ironwall 不鼓励 FFI。

FFI 是暂时的妥协，不是 Ironwall 的理想边界。原因很直接：

- C 语言没有 Ironwall 想要提供的记忆体安全与型别安全保证。
- C 程式可以越界读写、悬空指标、破坏 runtime heap、破坏 GC metadata、错误释放记忆体。
- 一旦进入 C，Ironwall 的安全模型只能把 C 视为受信任但不安全的外部世界。

因此：

- FFI 只应用于必要的系统边界、既有 C library、平台 syscall 包装、过渡期 runtime glue。
- 不应把 FFI 当成常规抽象机制。
- 不应用 FFI 绕过 Ironwall 型别系统、GC、安全边界或模组规则。
- C 端 bug 视为可破坏整个程序的 bug，不视为 Ironwall 可以完整隔离的普通错误。

FFI 的存在是工程现实，不是语言方向。Ironwall 长期方向应是减少 FFI 面积，而不是扩大它。

## 2. 核心模型

C FFI 分成两个方向：

- Ironwall 调用 C：在 Ironwall 里用 `declare` 宣告外部 C 函数。
- C 调用 Ironwall：把符合命名规则的 Ironwall 函数导出成 C 可调用 wrapper。

两个方向使用不同 ABI：

- `declare ... clang ...` 是低阶 runtime ABI，C 函数直接收发 `iw_value_t`。
- `iwlang` export 是 host-friendly ABI，C 函数使用 `int64_t`、`const char *`、`char *`、host array struct。

这个分裂是有意的：

- Ironwall 调用 C 时，C 被视为 runtime 内部扩展，必须懂 `iw_value_t`。
- C 调用 Ironwall 时，外部 caller 不应直接依赖 heap object layout，所以 wrapper 会做值转换与拷贝。

## 3. 命名规则

FFI symbol 必须使用带 namespace UUID 与 confirmation tag 的完整名称。旧式裸 C symbol 不符合规范。

### 3.1 Ironwall 调用 C 的名称

格式：

```text
_<uuid>_clang_<function_name>_<tag1>
```

其中：

- `<uuid>` 是一段只含 ASCII 字母与数字的 namespace 字串。
- `clang` 固定表示「此 symbol 由 C 语言提供」。
- `<function_name>` 必须符合 C identifier 形状：`[A-Za-z_][A-Za-z0-9_]*`。
- `<tag1>` 是 8 位十六进制 confirmation tag。

例：

```text
_81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
```

若 tag 与 uuid/function name 不匹配，编译必须拒绝。

### 3.2 C 调用 Ironwall 的导出名称

格式：

```text
_<uuid>_iwlang_<function_name>_<tag1>
```

其中：

- `iwlang` 固定表示「此 symbol 由 Ironwall 导出」。
- 其他栏位规则与 `clang` 名称相同。

例：

```text
_4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_i5_roundtrip_bca9013a
```

### 3.3 tag 的目的

confirmation tag 不是安全密钥，也不是权限机制。它的作用是：

- 避免手写 symbol 时把 namespace 或 function name 写错还能静默连上。
- 让跨语言边界的名称有一层低成本一致性检查。
- 防止旧式裸 symbol 混入正式 FFI 规范。

实作应用同一套 hash 规则生成 tag；使用者不应手算 tag，应使用工具或现有 helper 生成。

### 3.4 confirmation tag 算法

confirmation tag 使用 Ironwall 当前 `hashText` 算法生成。

`hashText(input)` 定义为 64-bit FNV-1a：

- 初始值：`14695981039346656037`
- prime：`1099511628211`
- 对 input 的每个字元，按 `charCodeAt` / UTF-16 code unit 取整数值
- `hash = hash xor code_unit`
- `hash = (hash * prime) mod 2^64`
- 最终输出 16 位小写十六进制字串，不足 16 位左侧补 `0`

`clang` declared C function 的 hash input：

```text
<uuid>clang<function_name>
```

`iwlang` exported Ironwall function 的 hash input：

```text
<uuid>iwlang<function_name>
```

`tag1` 是 `hashText(hash_input)` 的最后 8 个十六进制字元。

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

可运行的 Node.js 验证程式：

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

期望输出：

```text
6d7038b4c267f2a7
_81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
_4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_i5_roundtrip_bca9013a
_4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_s3_roundtrip_d247d3be
_4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_array_i5_roundtrip_f3f8886c
```

## 4. Ironwall 调用 C

### 4.1 Ironwall 宣告语法

Ironwall 用 `declare` 宣告 C 函数：

```ironwall
(declare
  (function _81af42c9d7354eb08bfe95163c04ad20_clang_iw_build_json_add_seven_c267f2a7
    ([value i5])
    to i5))
```

使用时和普通函数一样：

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

### 4.2 C 端函数签名

`declare` 的 C ABI 目前是 `iw_value_t` ABI。C 函数必须直接收发 `iw_value_t`：

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

注意：`iw_value_t` 的 `iw_as_i64` / `iw_from_i64` 是 tagged immediate 的承载格式，不是所有整数型别的语义位宽。`i5` 的语义位宽是 32-bit；declared C 函数若把 `i5` 当原生数值使用，必须在 C 端显式转成 `int32_t` 后再运算。

### 4.3 `unit` 返回值

Ironwall 的 `unit` 在 C ABI 中仍以 `iw_value_t` 表示。C 端应返回 `iw_from_i64(0)`：

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

若 declared C 函数需要返回 `s3`、`<array i5>`、`<array s3>`，backend 会在需要时提供 helper：

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

### 4.5 declared C 的可传型别

目前 `declare ... clang ...` 方向允许使用 Ironwall 普通函数型别中的值型别，但正式、可移植、建议使用的集合是：

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

- 所有值在 declared C ABI 上都以 `iw_value_t` 进出。
- integer、unsigned、bool、unit 是 immediate `iw_value_t`。
- float、text、complex、array 是 heap/reference `iw_value_t`。
- `<array i5>` 与 `<array s3>` 有稳定 helper。
- 其他 heap 型别虽可能在 backend 内部以 `iw_value_t` 存在，但不应作为公开 C FFI API。

不建议跨 declared C 边界传：

- class instance
- closure
- union
- nested array
- generic class instance，除了 `<array i5>` / `<array s3>`

这些型别会把 C 绑到 Ironwall 内部 layout、GC metadata 与 runtime tag，安全性和相容性都差。

## 5. C 调用 Ironwall

### 5.1 导出方式

Ironwall 函数若要导出给 C，函数名必须使用 `iwlang` 命名规则：

```ironwall
{program app@main
  (function _4a8b9c0d1e2f34567890abcdef123456_iwlang_iw_export_i5_roundtrip_bca9013a
    ([value i5])
    to i5
    in
    (add value $1^i5))
}
```

backend 会为此函数生成 C wrapper。

### 5.2 C 可见签名

C 调用 Ironwall 不直接使用 declared C 的 `iw_value_t` ABI，而使用 host-friendly ABI：

| Ironwall 型别 | C 参数型别 | C 返回型别 |
| --- | --- | --- |
| `i5` | `int32_t` | `int32_t` |
| `s3` | `const char *` | `char *` |
| `<array i5>` | `iw_host_array_i5_t` | `iw_host_array_i5_t` |
| `<array s3>` | `iw_host_array_s3_t` | `iw_host_array_s3_t` |

目前 C 调用 Ironwall 只支持上表型别。其他型别不得作为 exported IW function 的参数或返回值。

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

### 5.3 记忆体所有权

导出 wrapper 会在 C/Ironwall 边界做拷贝。

规则：

- C 传入 `const char *` 时，wrapper 会把它拷贝成 Ironwall `s3`。
- C 传入 array struct 时，wrapper 会拷贝 array 内容。
- Ironwall 返回 `s3` 时，wrapper 会配置一段 C `char *`。
- Ironwall 返回 `<array i5>` 或 `<array s3>` 时，wrapper 会配置 C array struct 内的 `items`。
- C caller 必须释放 wrapper 返回的 heap memory。

生成 header/runtime 会提供释放 helper：

```c
static inline void iw_host_free_s3(char *value);
static inline void iw_host_free_array_i5(iw_host_array_i5_t value);
static inline void iw_host_free_array_s3(iw_host_array_s3_t value);
```

### 5.4 C 调用 Ironwall 例子

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

## 6. GC 与安全要求

C FFI 必须遵守以下规则：

- C 不得保存未经规范允许的 Ironwall heap 指标作为长期状态。
- C 不得手动 `free` Ironwall heap object。
- C 不得伪造 `iw_value_t` heap reference。
- C 不得修改 Ironwall heap header、runtime type tag、GC tag 或 metadata table。
- C 若建立 Ironwall heap 值，必须使用 runtime/helper 函数。
- C 若需要返回 `unit`，必须返回 `iw_from_i64(0)`。
- C 若在 exported IW wrapper 返回 `char *` / host array 后取得所有权，必须使用对应 `iw_host_free_*` helper 释放。

GC 方面：

- FFI 不改变 Ironwall 显式 GC 的立场。
- C 端不应在未理解 thread attach/root 规则时直接操纵 GC。
- exported IW wrapper 会处理当前 thread attach 与必要 roots；C caller 不应绕过 wrapper 直接呼叫内部 lowered function。

## 7. 不鼓励模式

以下模式不符合 Ironwall 安全立场：

- 把大量业务逻辑写在 C 里，只把 Ironwall 当 glue。
- 用 C 直接操作 Ironwall class/closure/union 内部 layout。
- 用 FFI 传裸指标、地址整数、未标记 buffer ownership。
- 把 C global state 当作 Ironwall 型别系统之外的共享可变状态。
- 依赖未文档化 runtime struct layout。
- 用 FFI 绕过 `unit`、array bounds、GC root、module identity 等语义规则。

若一个功能可以用 Ironwall 写，就应优先用 Ironwall 写。FFI 只应作为暂时跨越不安全外部世界的窄桥。
