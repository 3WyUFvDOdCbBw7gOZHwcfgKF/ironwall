# Ironwall 核心語義規格

本文描述 Ironwall 的核心語義，包括作用域、求值規則、可變性、類與陣列的約束，以及錯誤模型。

## 1. 總體原則

- 顯式優先於隱式。
- 可靜態分析優先於語法糖堆疊。
- 安全與可審計優先於複雜的隱式行為。
- 不提供語言級異常系統。

## 2. 作用域與名字解析

核心表達式內部的名字解析順序為：

1. 局部詞法作用域
2. 本 package 的 top-level 名字
3. imported package 的 top-level 名字（包含顯式導入的 `std~...` package 名字）
4. 語言 builtin 名字

模組層更細的 package 規則由模組規格定義。

## 3. 可變性

### 3.1 可變綁定

以下綁定在語義上可被 `var_set` 修改：

- `var` 引入的局部變量
- `let` 綁定
- 對當前 unit 可見的 top-level global

### 3.2 不可變綁定

以下綁定為 immutable：

- `fn` / `function` 參數
- 類方法與 constructor 中的參數
- `self`

對 immutable 綁定執行 `var_set` 必須報錯。

## 4. `let` 的可見性

- `let` 綁定按照書寫順序由左到右生效。
- 普通綁定值不能前向引用後面的普通綁定。
- 若某綁定值本身是 `fn`，則該 `fn` 可參與局部遞迴函數集合。
- 即使在局部遞迴情況下，普通非函數綁定仍維持 prefix-visible 規則。

## 5. 控制流

### 5.1 `if`

- `cond` 必須是 `bool`
- `then` 與 `else` 分支型別必須一致
- 只求值被選中的分支

### 5.2 `while`

- `condition` 必須是 `bool`
- 每輪先測試條件，再執行 body
- `while` 整體型別固定為 `unit`

### 5.3 `cond`

- `else` 必須存在且必須是最後一支
- 非 `else` 條件都必須是 `bool`
- 所有分支結果型別必須一致

### 5.4 block

- `{e1 ... eN}` 依書寫順序求值
- block 的值為最後一個表達式的值

## 6. 聯合與 `match`

### 6.1 union 成員提升

- 若 `T` 是 `<union ...>` 的成員，則 `T` 值可直接賦給該 union 型別。
- union 運行時必須攜帶 tag。

### 6.2 `match`

- 被匹配值必須是 union 型別。
- 分支集合必須窮盡覆蓋所有 union 成員型別。
- 每個分支 bind 上的型別必須對應某個 union 成員。
- 各分支 body 的結果型別必須一致。
- 若某個 union 成員本身也是 union，外層 `match` 會綁定該巢狀 union 值；必須再用第二層 `match` 才能檢查巢狀 union 自己的 runtime tag 與 payload。

若值不滿足 `match` 的型別前提，屬不可恢復失敗。

## 7. 類與物件

### 7.1 類的基本約束

- 每個類必須有constructor,可以用多個constructor, 通過參數唯一性來進行重載。
- property 名稱在類內必須唯一。
- method 名稱在類內必須唯一。
- property 與 method 不可同名。
- 不支持繼承。
- 未標記 `public` 的 property / method 默認為 private。
- `(public ...)` 只可標記 property / method；constructor 默認 public。
- 普通 class 與 generic class 遵守相同的成員可見性規則。

### 7.2 constructor 約束

- constructor 必須初始化所有 property。
- constructor 不得在 property 尚未初始化時讀取該 property。
- 透過 method 間接讀取 property 時，也必須滿足初始化順序要求。

### 7.3 `self`

- `self` 只在 method 與 constructor 內自動綁定。
- `self` 是 immutable 綁定，但其欄位可透過 `cm_set` 被初始化或修改。

### 7.4 成員可見性

- class 外部透過 `cm_get`、member-chain sugar 或方法值取得，只能讀取 public property / method。
- class 外部透過 `cm_set` 只能寫入 public property。
- class 的 method / constructor 內部可透過 `self` 讀寫同一 class 的 private property，並可讀取同一 class 的 private method。
- generic class 實例化後仍保留來源 generic class 的 property / method 可見性。
- 對 private 成員的外部訪問必須作為靜態錯誤拒絕。

## 8. 陣列

- `<array T>` 是定長陣列。
- `array_get` / `array_set` 必須做越界檢查。
- `array_length` 返回 `i5`。
- 若某 class 被 `array_new` 當作元素型別批量建立，則該 class 必須具備零參數 constructor。 這樣才能通過zero-arg constructor 來建數組。

## 9. Top-level global

- top-level `var` 在 module mode 下表示 global。
- global 必須顯式型別並帶初始化式。
- global 型別必須是 primitive type，或是至少包含一個 primitive member 的 union。
- global initializer 必須由靜態語義決定為 primitive payload。
- global initializer 不得讀取其他 global，也不得呼叫 user-defined function / generic function / `declare`。
- global initializer 只允許落在 static primitive subset 內的控制流與 builtin。
- 只要某個 global 對當前 unit 可見，該 global 就可讀可寫；短名路徑仍需遵守 import 可見性規則。

更細的 module-level global 規則由模組規格定義。

## 10. 錯誤模型

### 10.1 靜態錯誤

以下屬靜態診斷：

- 詞法錯誤
- 語法錯誤
- 型別錯誤
- 名字解析歧義
- 非法 top-level 結構
- global init cycle
- 對 immutable 綁定賦值

### 10.2 運行時失敗

以下屬不可恢復運行時失敗：

- 陣列越界
- union tag 非法
- 內建前提被破壞
- 違反執行前提的其他不可恢復失敗

### 10.3 異常禁令

- 語言層不提供 `throw`、`try`、`catch`。
- 可恢復失敗應由 union 或其他顯式資料模型建模。
