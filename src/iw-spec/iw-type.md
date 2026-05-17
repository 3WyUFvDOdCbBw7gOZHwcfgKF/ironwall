# Ironwall 型別系統規格

本文定義 Ironwall 的型別構成、型別相等、可賦值關係，以及泛型與聯合型別的收束規則。

## 1. 原始型別

primitive type 名單如下：

- 有號整數：`i5`、`i6`、`i7`
- 無號整數：`u5`、`u6`、`u7`
- 浮點：`f5`、`f6`、`f7`
- 複數：`z5`、`z6`、`z7`
- 字元：`c3`、`c4`、`c5`
- 字串：`s3`、`s4`、`s5`
- 其他：`bool`、`unit`

命名慣例為「前綴字母 + 指數 `n`」，其設計意圖是用 `2^n` 表示位寬等級；型別相等仍只看型別名本身。

## 2. 類型別

### 2.1 普通類

- 每個 top-level `class` 形成一個 nominal type。
- 類型別以類名識別，不採結構相等。

### 2.2 泛型類實例

- `<Pair i5 s3>`、`<Node i5>` 這類顯式實例化結果形成 concrete type。
- 泛型類實例仍是 nominal type，型別名與全部 type arguments 都必須一致。

### 2.3 內建泛型型別

的內建 generic type 為：

- `<array T>`

`array` 是 builtin runtime type，不是用戶定義 `class`。

## 3. 函數型別

函數型別寫作：

```ironwall
<to Ret from T1 T2 ...>
```

規則：

- 參數數量、參數順序、每個參數型別、返回型別都參與型別相等。
- 無參數函數仍屬函數型別的一種情況。

## 4. 聯合型別

聯合型別寫作：

```ironwall
<union T1 T2 ...>
```

收束規則：

- 聯合成員在型別層會 canonicalize。
- 巢狀 union 不會被展平；巢狀 union 會保留為直接成員型別。
- 重複的直接成員是型別錯誤，必須直接拒絕，不得靜默去重。
- 成員順序不影響最終型別相等。
- union 裏每個直接成員類型必須在該 union 裏唯一。


因此以下型別必須視為相等：

- `<union i5 f5>`
- `<union f5 i5>`

以下型別會保留巢狀 union 結構，因此與上述兩者不同：

- `<union i5 <union f5 i5>>`

以下型別非法，因為 `i5` 作為直接成員出現兩次：

- `<union i5 f5 i5>`

## 5. 型別相等

### 5.1 primitive

- 型別名完全一致才相等。

### 5.2 class

- 類名完全一致才相等。

### 5.3 generic class / generic function instance

- generic name 相同且 type arguments 全部 pairwise 相等才相等。

### 5.4 function type

- 參數個數相同。
- 參數順序相同。
- 對應參數型別相等。
- 返回型別相等。

### 5.5 union type
- 經 canonicalization 後，成員序列完全一致才相等。
- canonicalization 只會為型別相等排序直接成員，不會展平巢狀 union。

## 6. 可賦值關係

`isAssignable` 規則很保守：

- 若 `actual` 與 `expected` 型別相等，則可賦值。
- 若 `expected` 是 union，且 `actual` 與某一成員型別相等，則可賦值。
- 除此之外，不定義其他隱式可賦值關係。

這代表：

- `i5` 值可直接作為 `<union i5 f5>` 的成員值使用
- `i5` 不可隱式轉成 `f5`
- `<union i5 f5>` 不可隱式縮成 `i5`

## 7. 泛型

### 7.1 支持範圍

- 支持泛型類
- 支持泛型函數
- 不支持泛型 `declare`
- 不支持 type alias

### 7.2 顯式優先

- 泛型實例化必須顯式寫出全部 type arguments。
- 不提供根據實參自動補全 type arguments 的語言級推斷。
- 泛型函數名本身不能裸作值使用，必須先顯式實例化。

## 8. 顯式標註要求

以下位置都必須寫出顯式型別：

- `[name Type]` 綁定
- 函數參數
- 函數返回型別
- 類屬性
- top-level global

額外限制：

- top-level global 的宣告型別必須是 primitive type，或是至少含有一個 primitive member 的 union。
- top-level global initializer 的最終值必須是一個可賦值到該型別的 primitive payload。

不允許：

- 省略 `let` / `var` 綁定型別
- 省略函數返回型別
- 省略屬性型別

## 9. 數值型別規則

- 不存在預設整數型別或預設浮點型別。
- 數值字面量必須寫成 typed literal。
- 不存在 `i5 -> f5`、`f5 -> f6`、`i5 -> i6` 等隱式數值提升。
- 算術與比較 builtin 的可用簽名由 builtin 規格決定，而不是由隱式轉換補齊。

## 10. `unit`

- `unit` 同時是 primitive type 與其唯一值的拼寫。
- `unit` 常用於副作用流程、空結果、`<union unit T>` 與其他 union 類型的空分支。

## 11. 類型別名禁令

- 嚴格禁止 `type alias`。

## 12. 重載

- 函數通過，函數名和參數的唯一性進行重載。
- 泛型類，和泛型函數，通過泛型名字和泛型參數數量的唯一性進行重載。
