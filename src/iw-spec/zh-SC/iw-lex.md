# Ironwall 词法规格

本文定义 Ironwall 的词法边界。目标是让原子形状、语法糖与名字收束方式保持封闭，避免把歧义推迟到后续语法与语义阶段。

## 1. 设计原则

- 词法规则必须封闭、可预测、易于做静态诊断。
- 词法阶段只接受有限且明确的原子形状，不做「看上下文猜意思」的宽松解析。
- 模组系统相关复合名字在词法阶段即收束，不把 `~` / `@` 留给后续按字符二次拼接。
- `a.b.c` 这类链式写法只是表面语法糖，不是独立的运算子类别。

## 2. 允许字元

- 词法允许的非空白字元集合为：英文字母、十进位数字、`_`、`.`、`$`、`^`、`~`、`@`、四类括号。
- 空白字元只作为分隔用途，不保留语义。
- 超出此集合的字符必须在词法阶段直接报错。

## 3. 括号类型

Ironwall 区分四种括号，词法上必须保留其括号类型：

- 圆括号 `(` `)`
- 方括号 `[` `]`
- 大括号 `{` `}`
- 尖括号 `<` `>`

四类括号不是同构容器。不同括号对应不同语法域。

## 4. 标识符类别

### 4.1 普通标识符

- 正则：`[a-zA-Z_][a-zA-Z0-9_]*`
- 例：`x`、`foo`、`my_var`、`_tmp`

### 4.2 package path

- 正则：`seg (~ seg)*`
- 其中 `seg` 必须是普通标识符。
- 例：`app`、`a~b`、`std~time`、`test~fixtures~parser_structures`

### 4.3 package-qualified-name

- 正则：`<package-path>@<name>`
- `@` 左侧必须是完整 package path。
- `@` 右侧必须是单个普通标识符。
- 例：`app@main`、`app~cli@main`、`std~time@timestamp`

### 4.4 typed atom

Ironwall 只接受后缀型别写法的 typed atom：`$payload^type`。

- `payload` 在前，`type` 在后。
- `type` 必须是普通标识符。
- 若 `payload` 是标识符形状，表示 typed database reference。
- 若 `payload` 是数值形状，表示 typed numeric literal。
- 例：`$hello^s3`、`$line_break^c4`、`$42^i5`、`$3p14^f5`

### 4.5 package-qualified typed database reference

package-qualified database reference 的 canonical 形状为：`<package-path>$<reference-id>^<ty>`。

- 左侧必须是完整 package path，不可使用 `@`。
- `<reference-id>` 必须是普通标识符。
- package-qualified 形状只用于 database reference，不用于 numeric literal。
- 因此 `a~b~d$name^s3` 合法，而 `a~b~d$3p14^f5` 必须在词法阶段直接拒绝。

## 5. `$payload^type` 收束规则

### 5.1 typed database reference

当 `payload` 满足普通标识符形状，且整体不构成合法 typed numeric literal 时，该原子视为 typed database reference。

- 例：`$hello_world^s3`
- 例：`$answer_main^i5`
- 例：`a~b~d$banner_title^s3`

### 5.2 typed numeric literal

的数值型别前缀为：

- 有号整数：`i5`、`i6`、`i7`
- 无号整数：`u5`、`u6`、`u7`
- 浮点：`f5`、`f6`、`f7`
- 复数：`z5`、`z6`、`z7`

的数字 payload 规格如下。

#### 5.2.1 整数 payload

整数 payload 合法形状：

- `0`
- 十进位正整数，例如 `42`
- 十六进位整数，例如 `0x2A`
- 负整数编码，例如 `0neg332`

约束：

- 十进位正整数不允许无意义前导零；`0` 之外必须从 `1-9` 起头。
- `0x` 后必须至少有一个十六进位数字。
- 不支持 `0neg0x2A` 这种负十六进位写法；负数若要表达，必须使用十进位负整数 payload。
- 十六进位 payload 的定位是「按二进位表示对齐的字面量形状」，不是单纯为了提供另一种十进位数值拼写糖。
- 也就是说，`0x2A` 的意图是显式表达位元模式导向的整数书写，而不是鼓励把十六进位视为与十进位完全等价、可任意互换的表面表示。

#### 5.2.2 浮点 payload

浮点 payload 合法形状：

- 小数点以 `p` 取代，例如 `3p14`
- 支持负有限浮点，例如 `0neg3p14`
- 科学记号使用 `ep` / `en`，例如 `3p14ep23`、`3p14en20`
- 支持负有限科学计数，例如 `0neg3p14en20`
- 只带指数、没有小数部分的形状，例如 `5ep10`
- 特殊值：`inf`、`0neginf`、`nan`

约束：

- `p` 后的小数部分不可为空；`3p` 非法，必须写成 `3p0`。
- 指数部分必须是非负十进位整数。
- 负有限浮点以 `0neg` 前缀表示。

#### 5.2.3 复数 payload

Spec 层面明确支持 `z5`、`z6`、`z7` 复数字面量。

严格形状为：

```text
0real<RealPart>img<ImagPart>
```

其中：

- payload 必须以 `0real` 开头。
- `img` 必须且只能出现一次。
- `RealPart` 不可省略。
- `ImagPart` 不可省略。
- `RealPart` 与 `ImagPart` 都必须是合法实数 payload。
- 合法实数 payload 包括：整数、负整数、浮点、负浮点、科学计数、负科学计数、`inf`、`0neginf`、`nan`。
- 不允许使用 `+`、`-`、`.`、`e`、`i` 这类传统复数拼法混入 payload。

例：

- `$0real0neg42p32img0neg3p22^z5`
- `$0real3p14img2p0^z6`
- `$0realinfimg0neginf^z7`

非法例：

- `$0realimg1^z5`
- `$0real3p14^z5`
- `$3p14img2p0^z5`
- `$0real3p14img2p0img1^z5`

复数 payload 的语义是 primitive complex literal，而不是 `z*_rect` 调用的纯文本缩写。

#### 5.2.4 typed database reference 与 typed numeric literal 的判定

一般情况下，两者没有模糊：

- database reference 的 payload 是字母开头标识符形状。
- numeric literal 的 payload 主要是数字开头或关键字常量形状。

因此大部分情况下，两条路径在词法外形上天然分离。

唯一需要明文保留的例外是浮点关键字常量：

- `inf`
- `nan`

这两个 payload 虽然是字母开头，但在 `f5` / `f6` / `f7` 前缀下必须优先判定为 numeric literal，而不是 database reference。

也就是说：

- `$inf^f5` 是浮点字面量
- `$nan^f5` 是浮点字面量
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

不允许：

- 裸写 `42`
- 裸写 `3p14`
- 靠上下文推断预设数值型别

## 6. 链式语法糖展开

词法级只支持一种链式语法糖；它只允许 segment 为以下两类之一：

- 普通标识符
- package-qualified-name，例如 `a~b@c`

`$payload^ty` 与 `pkg$reference^ty` 都不参与任何链式展开。

### 6.1 点号链

`a.b.c` 会在词法展开阶段转成巢状 `cm_get` 调用。

- `a.b.c` -> `(cm_get (cm_get a b) c)`
- `a.b.c.d` -> `(cm_get (cm_get (cm_get a b) c) d)`
- `a~b@c.d~e@f.h~i@j` -> `(cm_get (cm_get a~b@c d~e@f) h~i@j)`
- 这是成员读取语义的词法糖，后续语义仍按 `cm_get` 的普通规则处理。
- 点号链必须在词法上是一个连续 raw chunk，因此 `a . b`、`a. b`、`a .b` 都非法。
- formatter 可在不改语义前提下，把可还原的巢状 `cm_get` 链写回 `a.b.c`。

### 6.2 非法链形状

非法例：

- `a-b-c`
- `hello..world`
- `foo.-bar`
- `$hello.world^s3`

## 7. 注解禁令

- 不定义 `//`、`#`、`/* */`、`;` 等任何注释语法。
- 需要说明文字时，应以 typed database entry 或其他普通语言资料表示。
- 注释不存在词法特权路径。

## 8. 非法形状示例

以下形状必须在词法或极早期语法阶段拒绝：

- `a~~b`
- `a~@main`
- `a~b@c@d`
- `1abc`
- `@main`
- `a~b.iw`
- `$hello.world^s3`
- 裸写数值 `42`
- `0real3p14img2p0`
- `i5$42`
- `a~b~d$3p14^f5`

## 9. 词法边界

- 括号类型必须在词法上保留。
- package path、package-qualified-name、typed reference 都以单个原子收束。
- `a.b.c` 在进入后续阶段前已展开，不保留链式原子。
