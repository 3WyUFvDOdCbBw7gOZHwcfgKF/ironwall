# Ironwall Builtin 边界规格

本文只描述 Ironwall 的语言 builtin。

## 1. 分层原则

Ironwall 将可用能力分成两层：

- 语言 builtin：由编译器直接识别，属核心语义
- `std~...` packages：以普通 top-level 定义提供的标准库

这条边界必须清楚：

- builtin 不需要 `import`
- `std~...` 导出名字必须透过对应的 `(import std~...)` 才可直接使用
- 不存在「因为来自 base lib，所以自动进入 builtin 名字集合」这种特权

## 2. 语言 builtin

### 2.1 builtin generic type

语言级 builtin generic type 为：

- `array`

拼写为：

```ironwall
<array T>
```

### 2.2 builtin call 名

核心 builtin call 名包括：

- `add`
- `sub`
- `mul`
- `div`
- `mod`
- `le`
- `lt`
- `ge`
- `gt`
- `eq`
- `neq`
- `not`
- `and`
- `or`
- `xor`
- `bwand`
- `bwor`
- `bwxor`
- `ls`
- `rs`
- `class_new`
- `cm_get`
- `cm_set`
- `array_new`
- `array_get`
- `array_set`
- `array_length`
- `s3_new`、`s3_get`、`s3_set`、`s3_length`
- `s4_new`、`s4_get`、`s4_set`、`s4_length`
- `s5_new`、`s5_get`、`s5_set`、`s5_length`
- `z5_new`、`z5_set`、`z5_real`、`z5_img`
- `z6_new`、`z6_set`、`z6_real`、`z6_img`
- `z7_new`、`z7_set`、`z7_real`、`z7_img`

只接受上述拼写；物件 primitive 只接受 `class_new` / `cm_get` / `cm_set`，变量重赋值只接受 `var_set`。

### 2.3 builtin 签名收束

- numeric arithmetic builtin `add` / `sub` / `mul` / `div` / `mod` 支持 `u5|u6|u7|i5|i6|i7|f5|f6|f7` 的同型别运算，不做跨型别提升
- comparison builtin `le` / `lt` / `ge` / `gt` / `eq` / `neq` 支持 `u5|u6|u7|i5|i6|i7|f5|f6|f7` 的同型别比较，返回 `bool`
- 同一组 comparison builtin 也支持 `c3|c4|c5` 的同型别比较，返回 `bool`；语义以单一 code-unit / byte 顺序比较为准
- `not` 支持 `(bool) -> bool`
- `and` / `or` / `xor` 只支持 `bool`
- bitwise / shift builtin `bwand` / `bwor` / `bwxor` / `ls` / `rs` 支持 `u5|u6|u7|i5|i6|i7`，不支持 `f5|f6|f7`
- `s3_new` / `s4_new` / `s5_new` 支持两组签名：`(sN) -> sN` 与 `(i5, cN) -> sN`
- `s3_get` / `s4_get` / `s5_get` 的签名为 `(sN, i5) -> cN`
- `s3_set` / `s4_set` / `s5_set` 的签名为 `(sN, i5, cN) -> unit`
- `s3_length` / `s4_length` / `s5_length` 的签名为 `(sN) -> i5`
- `z5_new` / `z6_new` / `z7_new` 的签名为 `(zN) -> zN`
- `z5_set` / `z6_set` / `z7_set` 支持两组签名：`(zN, zN) -> unit` 与 `(zN, fN, fN) -> unit`
- `z5_real` / `z5_img` 返回 `f5`；`z6_real` / `z6_img` 返回 `f6`；`z7_real` / `z7_img` 返回 `f7`
- frontend surface sugar 另外接受 `add` / `mul` / `and` / `or` 的 `>= 2` 参数写法，语义上收敛成右结合 binary tree；例如 `(add a b c d)` 等价于 `(add a (add b (add c d)))`
- frontend surface sugar 另外接受 `sub` 的 `>= 2` 参数写法，语义上收敛成左结合 binary tree；例如 `(sub a b c d)` 等价于 `(sub (sub (sub a b) c) d)`
- frontend surface sugar 另外接受 `le` / `lt` / `ge` / `gt` / `eq` 的 `>= 2` 参数写法；语义上展开成 pairwise comparison chain 并用右结合 `and` 连起来
- 上述 variadic surface sugar 不改变 builtin 的核心 type boundary：`0` 参数 form 仍然非法，`not` 保持为独立的 unary `(bool) -> bool` builtin，而 `div` / `mod` / `neq` / `xor` / `not` 也不自动加入这组 sugar

### 2.4 物件与阵列 primitive

- `class_new` 的合法性由目标类的 constructor 决定
- `cm_get` / `cm_set` 是类物件 primitive，不是一般函数库 API
- `array_new` / `array_get` / `array_set` / `array_length` 是阵列 primitive，不是 `std~...` package helper
- `s3_*` / `s4_*` / `s5_*` 是文字 primitive family，不是 `std~...` package helper
- `z5_*` / `z6_*` / `z7_*` 是 primitive complex copy/update/projection family，不是 `std~...` package helper

## 4. 可见性与保留名字

规格中：

- builtin 名字属全域 reserved top-level names
- `self` 是保留名字
- `std~...` package 汇出的普通名字都不是全域 reserved set

这代表：

- 用户 package 不得导出 `add`、`array_new`、`s3_new`、`z5_real`、`self` 这类名字
- `print`、`sin`、`val_to_f7`、`bin_to_f7` 这类 `std~...` 导出名只是在对应 package 内以 `(export ...)` 暴露的普通名字，不是语言 builtin
