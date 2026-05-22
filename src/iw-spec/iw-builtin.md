# Ironwall Builtin 邊界規格

本文只描述 Ironwall 的語言 builtin。

## 1. 分層原則

Ironwall 將可用能力分成兩層：

- 語言 builtin：由編譯器直接識別，屬核心語義
- `std~...` packages：以普通 top-level 定義提供的標準庫

這條邊界必須清楚：

- builtin 不需要 `import`
- `std~...` 導出名字必須透過對應的 `(import std~...)` 才可直接使用
- 不存在「因為來自 base lib，所以自動進入 builtin 名字集合」這種特權

## 2. 語言 builtin

### 2.1 builtin generic type

語言級 builtin generic type 為：

- `array`

拼寫為：

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

只接受上述拼寫；物件 primitive 只接受 `class_new` / `cm_get` / `cm_set`，變量重賦值只接受 `var_set`。

### 2.3 builtin 簽名收束

- numeric arithmetic builtin `add` / `sub` / `mul` / `div` / `mod` 支持 `u5|u6|u7|i5|i6|i7|f5|f6|f7` 的同型別運算，不做跨型別提升
- comparison builtin `le` / `lt` / `ge` / `gt` / `eq` / `neq` 支持 `u5|u6|u7|i5|i6|i7|f5|f6|f7` 的同型別比較，返回 `bool`
- 同一組 comparison builtin 也支持 `c3|c4|c5` 的同型別比較，返回 `bool`；語義以單一 code-unit / byte 順序比較為準
- `not` 支持 `(bool) -> bool`
- `and` / `or` / `xor` 只支持 `bool`
- bitwise / shift builtin `bwand` / `bwor` / `bwxor` / `ls` / `rs` 支持 `u5|u6|u7|i5|i6|i7`，不支持 `f5|f6|f7`
- `s3_new` / `s4_new` / `s5_new` 支持兩組簽名：`(sN) -> sN` 與 `(i5, cN) -> sN`
- `s3_get` / `s4_get` / `s5_get` 的簽名為 `(sN, i5) -> cN`
- `s3_set` / `s4_set` / `s5_set` 的簽名為 `(sN, i5, cN) -> unit`
- `s3_length` / `s4_length` / `s5_length` 的簽名為 `(sN) -> i5`
- `z5_new` / `z6_new` / `z7_new` 的簽名為 `(zN) -> zN`
- `z5_set` / `z6_set` / `z7_set` 支持兩組簽名：`(zN, zN) -> unit` 與 `(zN, fN, fN) -> unit`
- `z5_real` / `z5_img` 返回 `f5`；`z6_real` / `z6_img` 返回 `f6`；`z7_real` / `z7_img` 返回 `f7`
- frontend surface sugar 另外接受 `add` / `mul` / `and` / `or` 的 `>= 2` 參數寫法，語義上收斂成右結合 binary tree；例如 `(add a b c d)` 等價於 `(add a (add b (add c d)))`
- frontend surface sugar 另外接受 `sub` 的 `>= 2` 參數寫法，語義上收斂成左結合 binary tree；例如 `(sub a b c d)` 等價於 `(sub (sub (sub a b) c) d)`
- frontend surface sugar 另外接受 `le` / `lt` / `ge` / `gt` / `eq` 的 `>= 2` 參數寫法；語義上展開成 pairwise comparison chain 並用右結合 `and` 連起來
- 上述 variadic surface sugar 不改變 builtin 的核心 type boundary：`0` 參數 form 仍然非法，`not` 保持爲獨立的 unary `(bool) -> bool` builtin，而 `div` / `mod` / `neq` / `xor` / `not` 也不自動加入這組 sugar

### 2.4 物件與陣列 primitive

- `class_new` 的合法性由目標類的 constructor 決定
- `cm_get` / `cm_set` 是類物件 primitive，不是一般函數庫 API
- `array_new` / `array_get` / `array_set` / `array_length` 是陣列 primitive，不是 `std~...` package helper
- `s3_*` / `s4_*` / `s5_*` 是文字 primitive family，不是 `std~...` package helper
- `z5_*` / `z6_*` / `z7_*` 是 primitive complex copy/update/projection family，不是 `std~...` package helper

## 4. 可見性與保留名字

規格中：

- builtin 名字屬全域 reserved top-level names
- `self` 是保留名字
- `std~...` package 匯出的普通名字都不是全域 reserved set

這代表：

- 用戶 package 不得導出 `add`、`array_new`、`s3_new`、`z5_real`、`self` 這類名字
- `print`、`sin`、`val_to_f7`、`bin_to_f7` 這類 `std~...` 導出名只是在對應 package 內以 `(export ...)` 暴露的普通名字，不是語言 builtin
