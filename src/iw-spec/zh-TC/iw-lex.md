# Ironwall 詞法規格

本文定義 Ironwall 的詞法邊界。目標是讓原子形狀、語法糖與名字收束方式保持封閉，避免把歧義推遲到後續語法與語義階段。

## 1. 設計原則

- 詞法規則必須封閉、可預測、易於做靜態診斷。
- 詞法階段只接受有限且明確的原子形狀，不做「看上下文猜意思」的寬鬆解析。
- 模組系統相關複合名字在詞法階段即收束，不把 `~` / `@` 留給後續按字符二次拼接。
- `a.b.c` 這類鏈式寫法只是表面語法糖，不是獨立的運算子類別。

## 2. 允許字元

- 詞法允許的非空白字元集合為：英文字母、十進位數字、`_`、`.`、`$`、`^`、`~`、`@`、四類括號。
- 空白字元只作為分隔用途，不保留語義。
- 超出此集合的字符必須在詞法階段直接報錯。

## 3. 括號類型

Ironwall 區分四種括號，詞法上必須保留其括號類型：

- 圓括號 `(` `)`
- 方括號 `[` `]`
- 大括號 `{` `}`
- 尖括號 `<` `>`

四類括號不是同構容器。不同括號對應不同語法域。

## 4. 標識符類別

### 4.1 普通標識符

- 正則：`[a-zA-Z_][a-zA-Z0-9_]*`
- 例：`x`、`foo`、`my_var`、`_tmp`

### 4.2 package path

- 正則：`seg (~ seg)+`
- 其中 `seg` 必須是普通標識符。
- 例：`a~b`、`std~time`、`test~fixtures~parser_structures`

### 4.3 package-qualified-name

- 正則：`<package-path>@<name>`
- `@` 左側必須是完整 package path。
- `@` 右側必須是單個普通標識符。
- 例：`app~cli@main`、`std~time@timestamp`

### 4.4 typed atom

Ironwall 只接受後綴型別寫法的 typed atom：`$payload^type`。

- `payload` 在前，`type` 在後。
- `type` 必須是普通標識符。
- 若 `payload` 是標識符形狀，表示 typed database reference。
- 若 `payload` 是數值形狀，表示 typed numeric literal。
- 例：`$hello^s3`、`$line_break^c4`、`$42^i5`、`$3p14^f5`

### 4.5 package-qualified typed database reference

package-qualified database reference 的 canonical 形狀為：`<package-path>$<reference-id>^<ty>`。

- 左側必須是完整 package path，不可使用 `@`。
- `<reference-id>` 必須是普通標識符。
- package-qualified 形狀只用於 database reference，不用於 numeric literal。
- 因此 `a~b~d$name^s3` 合法，而 `a~b~d$3p14^f5` 必須在詞法階段直接拒絕。

## 5. `$payload^type` 收束規則

### 5.1 typed database reference

當 `payload` 滿足普通標識符形狀，且整體不構成合法 typed numeric literal 時，該原子視為 typed database reference。

- 例：`$hello_world^s3`
- 例：`$answer_main^i5`
- 例：`a~b~d$banner_title^s3`

### 5.2 typed numeric literal

的數值型別前綴為：

- 有號整數：`i5`、`i6`、`i7`
- 無號整數：`u5`、`u6`、`u7`
- 浮點：`f5`、`f6`、`f7`
- 複數：`z5`、`z6`、`z7`

的數字 payload 規格如下。

#### 5.2.1 整數 payload

整數 payload 合法形狀：

- `0`
- 十進位正整數，例如 `42`
- 十六進位整數，例如 `0x2A`
- 負整數編碼，例如 `0neg332`

約束：

- 十進位正整數不允許無意義前導零；`0` 之外必須從 `1-9` 起頭。
- `0x` 後必須至少有一個十六進位數字。
- 不支持 `0neg0x2A` 這種負十六進位寫法；負數若要表達，必須使用十進位負整數 payload。
- 十六進位 payload 的定位是「按二進位表示對齊的字面量形狀」，不是單純為了提供另一種十進位數值拼寫糖。
- 也就是說，`0x2A` 的意圖是顯式表達位元模式導向的整數書寫，而不是鼓勵把十六進位視為與十進位完全等價、可任意互換的表面表示。

#### 5.2.2 浮點 payload

浮點 payload 合法形狀：

- 小數點以 `p` 取代，例如 `3p14`
- 支持負有限浮點，例如 `0neg3p14`
- 科學記號使用 `ep` / `en`，例如 `3p14ep23`、`3p14en20`
- 支持負有限科學計數，例如 `0neg3p14en20`
- 只帶指數、沒有小數部分的形狀，例如 `5ep10`
- 特殊值：`inf`、`0neginf`、`nan`

約束：

- `p` 後的小數部分不可為空；`3p` 非法，必須寫成 `3p0`。
- 指數部分必須是非負十進位整數。
- 負有限浮點以 `0neg` 前綴表示。

#### 5.2.3 複數 payload

Spec 層面明確支持 `z5`、`z6`、`z7` 複數字面量。

嚴格形狀為：

```text
0real<RealPart>img<ImagPart>
```

其中：

- payload 必須以 `0real` 開頭。
- `img` 必須且只能出現一次。
- `RealPart` 不可省略。
- `ImagPart` 不可省略。
- `RealPart` 與 `ImagPart` 都必須是合法實數 payload。
- 合法實數 payload 包括：整數、負整數、浮點、負浮點、科學計數、負科學計數、`inf`、`0neginf`、`nan`。
- 不允許使用 `+`、`-`、`.`、`e`、`i` 這類傳統複數拼法混入 payload。

例：

- `$0real0neg42p32img0neg3p22^z5`
- `$0real3p14img2p0^z6`
- `$0realinfimg0neginf^z7`

非法例：

- `$0realimg1^z5`
- `$0real3p14^z5`
- `$3p14img2p0^z5`
- `$0real3p14img2p0img1^z5`

複數 payload 的語義是 primitive complex literal，而不是 `z*_rect` 調用的純文本縮寫。

#### 5.2.4 typed database reference 與 typed numeric literal 的判定

一般情況下，兩者沒有模糊：

- database reference 的 payload 是字母開頭標識符形狀。
- numeric literal 的 payload 主要是數字開頭或關鍵字常量形狀。

因此大部分情況下，兩條路徑在詞法外形上天然分離。

唯一需要明文保留的例外是浮點關鍵字常量：

- `inf`
- `nan`

這兩個 payload 雖然是字母開頭，但在 `f5` / `f6` / `f7` 前綴下必須優先判定為 numeric literal，而不是 database reference。

也就是說：

- `$inf^f5` 是浮點字面量
- `$nan^f5` 是浮點字面量
- `$inf^s3` 仍是 database reference
- `$answer^i5` 仍是 database reference

#### 5.2.5 例子

合法：

- `$0^i5`
- `$42^i5`
- `$0neg332^i5`
- `$0x2A^u5`
- `$3p14^f5`
- `$0neg3p14^f5`
- `$3p14ep23^f6`
- `$3p14en20^f7`
- `$0neg3p14en20^f5`
- `$inf^f5`
- `$0neginf^f5`
- `$nan^f5`
- `$0real0neg42p32img0neg3p22^z5`
- `$0real3p14img2p0^z6`
- `$0realinfimg0neginf^z7`
- `$hello^s3`
- `a~b~d$hello^s3`

非法：

- `42`
- `0p0`
- `$001^i5`
- `$0neg0x2A^i5`
- `$0realimg1^z5`
- `$3p14img2p0^z5`
- `$0real3p14img2p0img1^z5`
- `i5$42`
- `s3$hello`
- `a~b~d$3p14^f5`

不允許：

- 裸寫 `42`
- 裸寫 `3p14`
- 靠上下文推斷預設數值型別

## 6. 鏈式語法糖展開

詞法級只支持一種鏈式語法糖；它只允許 segment 為以下兩類之一：

- 普通標識符
- package-qualified-name，例如 `a~b@c`

`$payload^ty` 與 `pkg$reference^ty` 都不參與任何鏈式展開。

### 6.1 點號鏈

`a.b.c` 會在詞法展開階段轉成巢狀 `cm_get` 調用。

- `a.b.c` -> `(cm_get (cm_get a b) c)`
- `a.b.c.d` -> `(cm_get (cm_get (cm_get a b) c) d)`
- `a~b@c.d~e@f.h~i@j` -> `(cm_get (cm_get a~b@c d~e@f) h~i@j)`
- 這是成員讀取語義的詞法糖，後續語義仍按 `cm_get` 的普通規則處理。
- 點號鏈必須在詞法上是一個連續 raw chunk，因此 `a . b`、`a. b`、`a .b` 都非法。
- formatter 可在不改語義前提下，把可還原的巢狀 `cm_get` 鏈寫回 `a.b.c`。

### 6.2 非法鏈形狀

非法例：

- `a-b-c`
- `hello..world`
- `foo.-bar`
- `$hello.world^s3`

## 7. 註解禁令

- 不定義 `//`、`#`、`/* */`、`;` 等任何注釋語法。
- 需要說明文字時，應以 typed database entry 或其他普通語言資料表示。
- 注釋不存在詞法特權路徑。

## 8. 非法形狀示例

以下形狀必須在詞法或極早期語法階段拒絕：

- `a~~b`
- `a~@main`
- `a~b@c@d`
- `1abc`
- `@main`
- `a~b.iw`
- `$hello.world^s3`
- 裸寫數值 `42`
- `0real3p14img2p0`
- `i5$42`
- `a~b~d$3p14^f5`

## 9. 詞法邊界

- 括號類型必須在詞法上保留。
- package path、package-qualified-name、typed reference 都以單個原子收束。
- `a.b.c` 在進入後續階段前已展開，不保留鏈式原子。
