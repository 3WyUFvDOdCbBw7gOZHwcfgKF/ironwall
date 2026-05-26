# Ironwall 模組系統規格

本文定義 Ironwall 的多文件模組語義。核心原則是語義身份只由 unit id 決定，並把 import、package export、entry、global init 全部收束到同一套封閉規則中。

## 1. 核心術語

### 1.1 源單元

- 一個參與 module mode 的 `.iw` 文件就是一個源單元。
- 源單元的語言級身份由文件名 stem 決定。

### 1.2 package path

- package path 由普通標識符以 `~` 串接而成。
- package path 可以是單段，也可以是多段。
- 例：`app`、`a~b~c`

### 1.3 unit id

- 規範 unit id 形狀為 `<package-path>@<unit-name>`。
- 例：`app@main`、`app~cli@main`

### 1.4 literal db asset

- literal db 是 package 級資產，不是匿名 JSON 映射。
- 一個 literal db 文件對應 package 內一個 database reference bundle，而不是單一 reference。
- 規範文件名形狀為 `<package-path>$<reference-bundle>.json`。
- 例：`app~assets$banner.json`

## 2. 文件名與 `program` header

### 2.1 規範文件名

多文件 module mode 下，規範文件名為：

```text
<package-path>@<unit-name>.iw
```

例如：

- `a~b@date.iw`
- `std~time@timestamp.iw`
- `app@main.iw`

### 2.2 規範 header

源文件根部必須寫成：

```ironwall
{program <package-path>@<unit-name>
  ...
}
```

### 2.3 一致性約束

以下情況必須拒絕編譯：

- 文件名 stem 與 `program` header 的 unit id 不一致
- 同一文件出現多個根 `program`
- 缺失規範 unit id
- 同一語義閉包中出現重複 unit id

## 3. 目錄語義

- 目錄在語言層沒有語義。
- 兩個位於不同工程位置但擁有同一 unit id 的源單元若同時參與編譯，視為同一 unit id 衝突。
- 目錄只屬於工程組織手段，不屬於語言語義。

literal db 文件同樣遵守此規則：語義身份只看文件 stem，不看所在目錄。

## 4. Top-level 結構限制

module mode 下，top-level 只允許：

- `(import package-path)`
- `(export top-level-definition-or-var)`
- `class`
- `function`
- `declare`
- 泛型 `class`
- 泛型 `function`
- top-level `var`

module mode 下禁止：

- 裸 top-level 執行表達式
- 非 top-level `import`
- 非 top-level `export`
- 非 top-level `class` / `function` / generic 定義

## 5. package 與導出

### 5.1 package identity

- package identity 只看 package path 字串本身。
- 一個 package 可由多個源單元共同組成。

### 5.2 package export 集

只有被 `(export ...)` 包裹的 top-level 具名定義進入普通 package export 集：

- `class`
- `function`
- `declare`
- 泛型 `class`
- 泛型 `function`
- top-level global

`(export exp)` 的 `exp` 只能是上述 top-level 語法節點之一，也就是 `class`、泛型 `class`、`function`、`declare`、泛型 `function` 或 top-level `var`。`export` 不允許包住 `import`、`var_set`、`let`、`fn`、控制流、呼叫、literal、identifier 或 `{...}` block。

未被 `export` 包裹的 top-level 名字仍屬於本 package，可被同 package 其他源單元解析與使用；但它不對其他 package 可見。

literal db references 仍按 literal db 文件規則形成 package-visible reference entry，不使用 `(export ...)` 包裹。

### 5.3 `main` 的特殊地位

- top-level `main` 是 unit-local entry symbol。
- `main` 不進入普通 package export 集。
- 其他單元不能用 `pkg@main` 把某個 unit 的 `main` 當普通導出符號引用。

## 6. `main` 規則

若某 top-level `function` 名為 `main`，則它必須滿足：

- 必須是非 `declare`
- 必須是非 generic
- 必須位於 top-level
- 參數數量必須為 1
- 參數名必須為 `args`
- 參數型別必須是 `<array s3>`
- 返回型別必須是 `i5`
- 單個 unit 最多只能定義一個 `main`

一個專案可以有多個 entry unit；若不唯一，則必須顯式選擇 entry unit。

## 7. `import`

### 7.1 語法與目標

```ironwall
(import a~b~c)
```

- import 的目標是 package path，不是文件路徑，不是 unit id。
- import 只能出現在 top-level。

### 7.2 重複、缺失與未使用

以下情況必須報錯：

- 同一 unit 重複 import 同一 package
- import 了一個不存在的 package
- import 最終沒有為任何短名或全限定跨 package 解析提供可見性貢獻

注意：

- `import` 決定跨 package 可見性，且只導入目標 package 本身。
- `import a~b` 不會隱式導入 `a~b~c` 或任何其他子 package。
- 跨 package 使用全限定名 `pkg@name` 或 `pkg$reference^ty` 時，`pkg` 也必須是本 unit 顯式 import 的 exact package。
- 使用已顯式 import 的全限定名算作使用該 import。

## 8. 名字解析

### 8.1 短名解析順序

未限定短名的解析順序為：

1. 局部詞法作用域
2. 本 package
3. imported packages 中已 export 的名字
4. builtin names

一旦某一層唯一命中，就停止向後搜尋。

### 8.2 本 package 優先

- 本 package 命中時，不得因 imported package 也有同名符號而升級成歧義。
- imported package 之間若同名且都匹配，則必須報二義性錯誤。

### 8.3 全限定名

包內導出符號的全限定名統一寫作：

```text
<package-path>@<symbol-name>
```

其語義是：

- 直接引用某 package 對外可見的 top-level 名字
- 目標 package 必須是本 package，或本 unit 顯式 import 的 exact package
- 不能越過 package 導出規則訪問未 export 名字或 unit-local 特例
- overload 解析只在同一 package 的同名函數集合內繼續進行

database reference 的 package-qualified 形狀不使用 `@`，而使用：

```text
<package-path>$<reference-id>^<ty>
```

其中：

- `@` 只保留給 package export 的 global / class / function 名字。
- `$` 只保留給 literal db reference 名字。
- 兩者是不同名字入口，不可混用。

若短名 database reference 在可見 package 集中不唯一，必須使用 package-qualified database reference。package-qualified database reference 的 package 也必須是本 package 或本 unit 顯式 import 的 exact package。

## 9. package 級符號衝突

採單一主名字空間加兩類有限 overload 例外模型。

以下情況必須報錯：

- 同 package 兩個 `class` 同名
- 同 package `class` 與普通 `function` 同名
- 同 package `class` 與 `global` 同名
- 同 package `class` 與泛型 `class` 同名
- 同 package `class` 與泛型 `function` 同名
- 同 package `global` 與 `function` / `declare` 同名
- 同 package `global` 與泛型 `class` 同名
- 同 package `global` 與泛型 `function` 同名
- 同 package 泛型 `class` 與普通 `function` / `declare` 同名
- 同 package 泛型 `function` 與普通 `function` / `declare` 同名
- 同 package 兩個泛型 `class` 名字相同且 type parameter 個數相同
- 同 package 兩個泛型 `function` 名字相同且 type parameter 個數相同
- 同 package 兩個完全相同簽名的普通函數或 declare 衝突

以下情況允許：

- 同 package 的普通具名函數依簽名形成 overload set
- 同 package 的泛型 `class` 可在同名下依 type parameter 個數形成 overload set
- 同 package 的泛型 `function` 可在同名下依 type parameter 個數形成 overload set
- 不同 package 出現相同導出名

補充規則：

- `class`、普通 `function` / `declare`、泛型 `class`、泛型 `function`、top-level `global` 共享同一 package 級主名字空間。
- 在這個主名字空間中，`class`、普通 `function` / `declare`、top-level `global` 的名字都必須彼此不同。
- 泛型 `class` 與泛型 `function` 也不得與上述任何非泛型名字重名。
- 唯一允許的重名情況有兩種：普通具名函數按函數簽名重載；泛型 `class` 或泛型 `function` 按 type parameter 個數重載。

### 9.1 literal db 規則

literal db 文件必須滿足：

- 文件名 stem 必須是 `<package-path>$<reference-bundle>`。
- JSON 頂層必須是 object。
- 所有 key 與所有 value 都必須是字串。
- 第一個 kv pair 的 key 不參與語義分析，可以是任意非空字串。
- 第一個 kv pair 的 value 必須精確等於文件 stem，用來與文件名對齊。
- 除第一個 kv pair 外，其他 kv pair 應預期可以有很多個；這些 kv pair 共同構成同一個 db bundle。
- 除第一個 kv pair 外，其他每個 key 都必須是 `referenceId^ty` 形狀。
- 除第一個 kv pair 外，其他每個 value 都必須是字串；數值型內容也必須以字串形式編碼，再由 typed reference 規則解釋。
- 同一 package 內，所有 db 文件的 `referenceId^ty` 必須全域唯一。

例：

```json
{
  "this_key_is_ignored_and_only_the_value_is_checked": "app~assets$banner",
  "hello^s3": "Hello",
  "answer^i5": "42"
}
```

以下情況必須報錯：

- 文件名 stem 與第一個 kv pair 的 value 不一致
- 同一 package 內出現重複 literal db entry name
- 源碼寫出 package-qualified non-reference 形狀，例如 `a~b~d$3p14^f5`

## 10. 保留名字

- 語言 builtin top-level 名字構成 reserved set。
- `self` 也是保留名字。
- `std~...` 匯出的普通名字都不是全域 reserved set，而是普通 imported package export。
- 用戶 package 不得定義與 builtin reserved set 衝突的 top-level export。
- 用戶 package 可定義未 export 的內部 helper；它們仍不得破壞同 package 主名字空間衝突規則，但不構成跨 package API。

## 11. Top-level global

### 11.1 基本規則

- top-level `var` 視為 global 定義。
- global 必須顯式型別並帶 initializer。
- global 宣告型別必須是 primitive type，或是至少含有一個 primitive member 的 union。
- 若 global 型別是 union，initializer 最終算出的 payload 也必須是一個可賦值到該 union 的 primitive payload。
- 不支持先宣告後補初始化。

### 11.2 可讀寫性

- 本 package 內可讀寫本 package global。
- 其他 package 的可見 global 也可讀寫。
- 對其他 package 使用短名或全限定名時，均需由 exact `import` 提供可見性；全限定名只消除短名歧義，不會繞過 import。

### 11.3 initializer 約束

global initializer 必須滿足：

- initializer 必須由靜態語義收斂成 primitive payload。
- initializer 不得讀取任何 global。
- initializer 不得呼叫普通函數、generic function、`declare`。
- initializer 不得做 class / array / closure / union object 配置這類 heap shape 建立。
- initializer 不得包含 `while`、`match` 或其他無法保證落在 static primitive subset 的節點。
- initializer 內若需要中間狀態，只能使用帶顯式型別的 local `let` / local `var`，且這些 local 的值也必須始終保持 primitive payload。

static primitive subset 至少包含：

- primitive typed literal
- literal db text reference
- `true`、`false`、`unit`
- `if`、`cond`、`{...}` block
- 帶顯式型別的 local `let`
- 帶顯式型別的 local `var` 與對該 local 的 `var_set`
- 直接 pure builtin call，且結果仍為 primitive payload

## 12. Global initialization model

- top-level global 的 initializer 語義結果必須靜態決定。
- global 之間不存在 initializer 讀依賴；因此不定義 user-visible 的 global init dependency graph。
- 文件發現順序、目錄順序、字典序都沒有語義效力。

## 13. Precompiled library

Precompiled library 是已封裝的 package 集。對使用者而言，它提供的 package export 與普通 source package export 一樣參與 `import`、名字解析、可見性與型別檢查。

基本規則：

- precompiled library 不改變 package path、unit id、import 或 export 的語義。
- 使用 precompiled library 內的 package，仍必須用 exact package path 顯式 `import`。
- precompiled library 只暴露其公開 export；未 export 名字不可見。
- 同一程式中，source package 與 precompiled library package 不得提供同一 package identity 的互相衝突定義。
- 對 precompiled library 的使用不得依賴其原始 source 是否可回讀。

### 13.1 泛型限制

Precompiled library 中 export 的 generic class / generic function 仍然是泛型符號，但可用的 concrete instantiation 受 library 已提供的實例集合限制。

規則：

- 使用 precompiled generic 時，type argument 必須先收斂成具體 endtype。
- 巢狀 generic instance 必須由內到外逐層收斂。
- 只有 library 已提供對應 concrete instantiation 時，該泛型使用才合法。
- 若缺少對應 concrete instantiation，屬靜態錯誤；使用者不得要求在消費端臨時展開 library 內部泛型定義。
- concrete instantiation 的語義身份必須保留來源 package-qualified generic name 與完整 type argument tuple，避免與其他 package 或其他 arity 的泛型混淆。

例：

```ironwall
(import lib~box)

(function use_box ([value <lib~box@Box i5>]) to i5 in
  (<lib~box@box_unwrap i5> value))
```

上例只有在 `lib~box` 提供 `<Box i5>` 與 `<box_unwrap i5>` 的 concrete instantiation 時才合法。若只提供 `<Box s3>`，則 `<Box i5>` 的使用必須作為靜態錯誤拒絕。

## 14. Entry

- 若沒有任何 top-level `main`，則無法生成可執行 entry。
- 若恰好一個 unit 定義 `main`，可自動選為 entry。
- 若多個 unit 定義 `main`，則必須顯式選擇 entry unit。
