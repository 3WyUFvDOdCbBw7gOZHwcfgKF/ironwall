# Ironwall 模组系统规格

本文定义 Ironwall 的多文件模组语义。核心原则是语义身份只由 unit id 决定，并把 import、package export、entry、global init 全部收束到同一套封闭规则中。

## 1. 核心术语

### 1.1 源单元

- 一个参与 module mode 的 `.iw` 文件就是一个源单元。
- 源单元的语言级身份由文件名 stem 决定。

### 1.2 package path

- package path 由普通标识符以 `~` 串接而成。
- package path 可以是单段，也可以是多段。
- 例：`app`、`a~b~c`

### 1.3 unit id

- 规范 unit id 形状为 `<package-path>@<unit-name>`。
- 例：`app@main`、`app~cli@main`

### 1.4 literal db asset

- literal db 是 package 级资产，不是匿名 JSON 映射。
- 一个 literal db 文件对应 package 内一个 database reference bundle，而不是单一 reference。
- 规范文件名形状为 `<package-path>$<reference-bundle>.json`。
- 例：`app~assets$banner.json`

## 2. 文件名与 `program` header

### 2.1 规范文件名

多文件 module mode 下，规范文件名为：

```text
<package-path>@<unit-name>.iw
```

例如：

- `a~b@date.iw`
- `std~time@timestamp.iw`
- `app@main.iw`

### 2.2 规范 header

源文件根部必须写成：

```ironwall
{program <package-path>@<unit-name>
  ...
}
```

### 2.3 一致性约束

以下情况必须拒绝编译：

- 文件名 stem 与 `program` header 的 unit id 不一致
- 同一文件出现多个根 `program`
- 缺失规范 unit id
- 同一语义闭包中出现重复 unit id

## 3. 目录语义

- 目录在语言层没有语义。
- 两个位于不同工程位置但拥有同一 unit id 的源单元若同时参与编译，视为同一 unit id 冲突。
- 目录只属于工程组织手段，不属于语言语义。

literal db 文件同样遵守此规则：语义身份只看文件 stem，不看所在目录。

## 4. Top-level 结构限制

module mode 下，top-level 只允许：

- `(import package-path)`
- `class`
- `function`
- `declare`
- 泛型 `class`
- 泛型 `function`
- top-level `var`

module mode 下禁止：

- 裸 top-level 执行表达式
- 非 top-level `import`
- 非 top-level `class` / `function` / generic 定义

## 5. package 与导出

### 5.1 package identity

- package identity 只看 package path 字串本身。
- 一个 package 可由多个源单元共同组成。

### 5.2 package export 集

以下 top-level 具名定义进入 package export 集：

- `class`
- `function`
- `declare`
- 泛型 `class`
- 泛型 `function`
- top-level global
- literal db references

### 5.3 `main` 的特殊地位

- top-level `main` 是 unit-local entry symbol。
- `main` 不进入普通 package export 集。
- 其他单元不能用 `pkg@main` 把某个 unit 的 `main` 当普通导出符号引用。

## 6. `main` 规则

若某 top-level `function` 名为 `main`，则它必须满足：

- 必须是非 `declare`
- 必须是非 generic
- 必须位于 top-level
- 参数数量必须为 1
- 参数名必须为 `args`
- 参数型别必须是 `<array s3>`
- 返回型别必须是 `i5`
- 单个 unit 最多只能定义一个 `main`

一个专案可以有多个 entry unit；若不唯一，则必须显式选择 entry unit。

## 7. `import`

### 7.1 语法与目标

```ironwall
(import a~b~c)
```

- import 的目标是 package path，不是文件路径，不是 unit id。
- import 只能出现在 top-level。

### 7.2 重复、缺失与未使用

以下情况必须报错：

- 同一 unit 重复 import 同一 package
- import 了一个不存在的 package
- import 最终没有为任何短名或全限定跨 package 解析提供可见性贡献

注意：

- `import` 决定跨 package 可见性，且只导入目标 package 本身。
- `import a~b` 不会隐式导入 `a~b~c` 或任何其他子 package。
- 跨 package 使用全限定名 `pkg@name` 或 `pkg$reference^ty` 时，`pkg` 也必须是本 unit 显式 import 的 exact package。
- 使用已显式 import 的全限定名算作使用该 import。

## 8. 名字解析

### 8.1 短名解析顺序

未限定短名的解析顺序为：

1. 局部词法作用域
2. 本 package
3. imported packages
4. builtin names

一旦某一层唯一命中，就停止向后搜寻。

### 8.2 本 package 优先

- 本 package 命中时，不得因 imported package 也有同名符号而升级成歧义。
- imported package 之间若同名且都匹配，则必须报二义性错误。

### 8.3 全限定名

包内导出符号的全限定名统一写作：

```text
<package-path>@<symbol-name>
```

其语义是：

- 直接引用某 package 对外可见的 top-level 名字
- 目标 package 必须是本 package，或本 unit 显式 import 的 exact package
- 不能越过 package 导出规则访问 unit-local 特例
- overload 解析只在同一 package 的同名函数集合内继续进行

database reference 的 package-qualified 形状不使用 `@`，而使用：

```text
<package-path>$<reference-id>^<ty>
```

其中：

- `@` 只保留给 package export 的 global / class / function 名字。
- `$` 只保留给 literal db reference 名字。
- 两者是不同名字入口，不可混用。

若短名 database reference 在可见 package 集中不唯一，必须使用 package-qualified database reference。package-qualified database reference 的 package 也必须是本 package 或本 unit 显式 import 的 exact package。

## 9. package 级符号冲突

采单一主名字空间加两类有限 overload 例外模型。

以下情况必须报错：

- 同 package 两个 `class` 同名
- 同 package `class` 与普通 `function` 同名
- 同 package `class` 与 `global` 同名
- 同 package `class` 与泛型 `class` 同名
- 同 package `class` 与泛型 `function` 同名
- 同 package `global` 与 `function` / `declare` 同名
- 同 package `global` 与泛型 `class` 同名
- 同 package `global` 与泛型 `function` 同名
- 同 package 泛型 `class` 与普通 `function` / `declare` 同名
- 同 package 泛型 `function` 与普通 `function` / `declare` 同名
- 同 package 两个泛型 `class` 名字相同且 type parameter 个数相同
- 同 package 两个泛型 `function` 名字相同且 type parameter 个数相同
- 同 package 两个完全相同签名的普通函数或 declare 冲突

以下情况允许：

- 同 package 的普通具名函数依签名形成 overload set
- 同 package 的泛型 `class` 可在同名下依 type parameter 个数形成 overload set
- 同 package 的泛型 `function` 可在同名下依 type parameter 个数形成 overload set
- 不同 package 出现相同导出名

补充规则：

- `class`、普通 `function` / `declare`、泛型 `class`、泛型 `function`、top-level `global` 共享同一 package 级主名字空间。
- 在这个主名字空间中，`class`、普通 `function` / `declare`、top-level `global` 的名字都必须彼此不同。
- 泛型 `class` 与泛型 `function` 也不得与上述任何非泛型名字重名。
- 唯一允许的重名情况有两种：普通具名函数按函数签名重载；泛型 `class` 或泛型 `function` 按 type parameter 个数重载。

### 9.1 literal db 规则

literal db 文件必须满足：

- 文件名 stem 必须是 `<package-path>$<reference-bundle>`。
- JSON 顶层必须是 object。
- 所有 key 与所有 value 都必须是字串。
- 第一个 kv pair 的 key 不参与语义分析，可以是任意非空字串。
- 第一个 kv pair 的 value 必须精确等于文件 stem，用来与文件名对齐。
- 除第一个 kv pair 外，其他 kv pair 应预期可以有很多个；这些 kv pair 共同构成同一个 db bundle。
- 除第一个 kv pair 外，其他每个 key 都必须是 `referenceId^ty` 形状。
- 除第一个 kv pair 外，其他每个 value 都必须是字串；数值型内容也必须以字串形式编码，再由 typed reference 规则解释。
- 同一 package 内，所有 db 文件的 `referenceId^ty` 必须全域唯一。

例：

```json
{
  "this_key_is_ignored_and_only_the_value_is_checked": "app~assets$banner",
  "hello^s3": "Hello",
  "answer^i5": "42"
}
```

以下情况必须报错：

- 文件名 stem 与第一个 kv pair 的 value 不一致
- 同一 package 内出现重复 literal db entry name
- 源码写出 package-qualified non-reference 形状，例如 `a~b~d$3p14^f5`

## 10. 保留名字

- 语言 builtin top-level 名字构成 reserved set。
- `self` 也是保留名字。
- `std~...` 汇出的普通名字都不是全域 reserved set，而是普通 imported package export。
- 用户 package 不得定义与 builtin reserved set 冲突的 top-level export。

## 11. Top-level global

### 11.1 基本规则

- top-level `var` 视为 global 定义。
- global 必须显式型别并带 initializer。
- global 宣告型别必须是 primitive type，或是至少含有一个 primitive member 的 union。
- 若 global 型别是 union，initializer 最终算出的 payload 也必须是一个可赋值到该 union 的 primitive payload。
- 不支持先宣告后补初始化。

### 11.2 可读写性

- 本 package 内可读写本 package global。
- 其他 package 的可见 global 也可读写。
- 对其他 package 使用短名或全限定名时，均需由 exact `import` 提供可见性；全限定名只消除短名歧义，不会绕过 import。

### 11.3 initializer 约束

global initializer 必须满足：

- initializer 必须在 compile time 静态收敛成 primitive payload。
- initializer 不得读取任何 global。
- initializer 不得呼叫普通函数、generic function、`declare`。
- initializer 不得做 class / array / closure / union object 配置这类 heap shape 建立。
- initializer 不得包含 `while`、`match` 或其他无法保证落在 static primitive subset 的节点。
- initializer 内若需要中间状态，只能使用带显式型别的 local `let` / local `var`，且这些 local 的值也必须始终保持 primitive payload。

static primitive subset 至少包含：

- primitive typed literal
- literal db text reference
- `true`、`false`、`unit`
- `if`、`cond`、`{...}` block
- 带显式型别的 local `let`
- 带显式型别的 local `var` 与对该 local 的 `var_set`
- 直接 pure builtin call，且结果仍为 primitive payload

## 12. Global initialization model

- top-level global 的 initializer 语义结果在 compile time 就必须决定。
- global 之间不存在 initializer 读依赖；因此不定义 user-visible 的 global init dependency graph。
- 文件发现顺序、目录顺序、字典序都没有语义效力。
- 若某 global 没有被 entry reachable 程式片段读到，compiler 可以不把它纳入最终程式；这不改变语言级可观察语义。

## 13. Separate compilation artifacts

- 一个源单元可以独立被编译成自己的 unit artifact。
- 若该 unit 含有 GC-visible layout 或 top-level global，artifact 应携带该 unit 专属的 metadata table 与 global var table。
- metadata table 的 runtime identity 必须由 deterministic UUID 表示；link/整合时不得只靠载入顺序辨识它。
- 多个 separately compiled unit 被整合时，最终程式必须生成 metadata table collection 与 global var table collection。
- 这些 collection 是 runtime/GC 可见的连结结果；它们保留「每张表属于哪个 unit artifact」这个身份，而不是把所有条目无条件压平成失去 provenance 的单表。

### 13.1 precompiled lib archive

- toolchain 可以把一组 module 打包成 precompiled library archive，文件格式为 `.tgz`。
- archive 至少必须携带：
- `manifest.json`
- 每个 separately compiled unit 各自的 machine artifact
- 每个 separately compiled unit 各自的 runtime support artifact
- archive 不携带 source bundle；consumer 对 precompiled lib 的静态检查必须只依赖 manifest signature table，而不是重新读取 lib 源码。
- 同一 package 若拆成多个 unit，archive 内也必须保留这个 unit 边界；不得把它们偷偷压平成单一 `library.s` 而抹掉 per-unit metadata/global table identity。

### 13.2 manifest contracts

- manifest 的 `compiledUnits` 必须逐 unit 列出：
- `unitId`
- `assemblyPath`
- `supportPath`
- `metadataTableExportSymbol`
- `globalTableExportSymbol`
- `runtimeInitExportSymbol`
- `runtimeInitExportSymbol` 负责把该 unit 的 local metadata/global table 挂入 collection，并执行该 unit 的 top-level initialization body。
- manifest 必须携带这些 signature tables：
- global signatures
- class signatures
- function signatures
- generic class signatures
- generic function signatures
- 以上 signature table 内的名字，都必须使用完整 package-qualified name，而不是只存裸 exported short name。
- manifest 还必须携带 generic monomorph table：
- generic class monomorph table
- generic function monomorph table
- monomorph table 的 key 语义不是 source-level `<generic ...>` 字面形状，而是 `<generic, normalized endtype tuple>`。
- 若某个 monomorph entry 的 type arg 内还包含 user generic class instance，则它必须先递回正规化成 endtype，再写入 table。
- monomorph table 的 value 必须是 concrete class/function 的真实名字；这个名字可以是 monomorphized internal symbol，但必须保留来源 generic 的完整 package-qualified full name，而不是只剩 short export 或匿名 hash。
- consumer compile 与最终 link 都必须解析到同一个 concrete class/function 名字。

### 13.3 consuming precompiled libs

- 可以在普通 compile/check/run/emit 流程中额外载入一个或多个 precompiled lib archive。
- consumer 对 imported precompiled lib 的 class/function/global 静态检查，必须只依赖 manifest 的 signature table；不得要求 archive 内仍附带可回读的 source。
- loaded archive 内的 generic class/function signature，对 consumer 而言必须像 imported package export 一样可见。
- 当 consumer instantiate 某个来自 precompiled lib 的 generic class/function 时：
- 必须先把每个 type arg 递回收敛到 endtype。
- 然后以 `<generic, normalized endtype tuple>` 查 manifest 的 monomorph table。
- 若查到，必须改用该 concrete name。
- 若查不到，必须直接拒绝编译；不得偷偷回退成临时重新 monomorphize 该 lib generic。
- consumer compile 完成后，最终 link 必须把 archive 内的 per-unit artifact 一起链进去。

## 14. Entry

- 若没有任何 top-level `main`，则无法生成可执行 entry。
- 若恰好一个 unit 定义 `main`，可自动选为 entry。
- 若多个 unit 定义 `main`，则必须显式选择 entry unit。
