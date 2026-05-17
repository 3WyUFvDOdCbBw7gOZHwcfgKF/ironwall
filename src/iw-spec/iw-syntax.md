# Ironwall 語法規格

本文描述 Ironwall 的核心語法形狀。它只回答「怎麼寫」，不重複展開完整型別與模組語義；後者由型別、語義與模組規格分別定義。

## 1. 根結構

- 每個 module-mode `.iw` 源單元必須且只能有一個根塊：`{program <unit-id> ...}`。
- `program` 只能出現在根位置，不能巢狀出現在其他表達式中。
- `unit-id` 的規範形狀為 `<package-path>@<unit-name>`。

示例：

```ironwall
{program app~cli@main
  (function main ([args <array s3>]) to i5 in $0^i5)
}
```

## 2. 關鍵字

正式規格使用以下關鍵字：

- `var`
- `var_set`
- `function`

只接受上述關鍵字。

## 3. 綁定語法

綁定位置統一使用：

```ironwall
[name Type]
```

規則：

- `name` 必須是普通標識符。
- `Type` 必須明確寫出。
- `[x]`、`[x _]` 之類省略型別的寫法非法。

## 4. 區塊與順序

### 4.1 `{...}` block

```ironwall
{e1 e2 ... eN}
```

- 表示順序求值區塊。
- 返回最後一個表達式的值。
- 空 block 非法。

## 5. 變量與賦值

### 5.1 `var`

```ironwall
(var [x T] expr)
```

- 建立一個具名綁定並初始化。
- `var` 同時用於局部變量與 top-level global。

### 5.2 `var_set`

```ironwall
(var_set x expr)
```

- 對既有綁定重新賦值。
- 對物件欄位賦值不走 `var_set`，而走 `cm_set` builtin。

## 6. 函數

### 6.1 匿名函數 `fn`

```ironwall
(fn ([p1 T1] [p2 T2] ...) to Ret in body)
```

- `fn` 是一等值。
- 參數列表與返回型別都必須顯式寫出。

### 6.2 具名函數 `function`

```ironwall
(function name ([p1 T1] ...) to Ret in body)
```

- `function` 必須出現在 top-level。
- 同名具名函數可依參數型別形成 overload set。

### 6.3 `declare`

```ironwall
(declare (function name ([p1 T1] ...) to Ret))
```

- 宣告外部函數簽名，不提供 Ironwall 函數體。
- `declare` 只能出現在 top-level。

## 7. `let`

```ironwall
(let (([x T] e1) ([y U] e2) ...) in body)
```

- 綁定列表寫在雙層括號中。
- 每個綁定都必須帶顯式型別。
- `let` body 只有一個主體表達式。

## 8. 條件與迴圈

### 8.1 `if`

```ironwall
(if cond then a else b)
```

### 8.2 `while`

```ironwall
(while condition in body)
```

### 8.3 `cond`

```ironwall
(cond
  (c1 e1)
  (c2 e2)
  (else eN)
)
```

- `else` 分支必須位於最後。

## 9. 型別語法

### 9.1 函數型別

```ironwall
<to Ret from T1 T2 ...>
```

### 9.2 聯合型別

```ironwall
<union T1 T2 ...>
```

- union 型別必須包含唯一的直接成員型別。
- 重複的直接成員會在型別驗證時被拒絕，而不是被去重。
- 允許巢狀 union 語法；它表示一個巢狀 union 成員，不表示展開後的成員列表。

### 9.3 泛型名

```ironwall
<generic Name T1 T2 ...>
```

- 該形狀只用於宣告 generic class / generic function 的頭部。

## 10. 泛型宣告與實例化

### 10.1 泛型函數宣告

```ironwall
(function <generic id T> ([x T]) to T in x)
```

### 10.2 泛型類宣告

```ironwall
(class <generic Box T>
  (property [value T])
  (constructor ([v T]) in (cm_set self value v))
)
```

### 10.3 顯式實例化

```ironwall
<id i5>
(<id i5> $42^i5)
<Box i5>
```

- `<name T...>` 表示對 generic name 顯式套用型別參數。
- 若外層再包一層 `(...)`，則表示對實例化結果做呼叫。

## 11. `match`

```ironwall
(match value
  ([x T1] body1)
  ([y T2] body2)
  ...
)
```

- 每個分支都以一個 typed bind 開頭。

## 12. 類

### 12.1 類宣告

```ironwall
(class Point
  (property [x i5])
  (property [y i5])
  (method sum () to i5 in (add (cm_get self x) (cm_get self y)))
  (constructor ([x0 i5] [y0 i5]) in
    {
      (cm_set self x x0)
      (cm_set self y y0)
    }
  )
)
```

### 12.2 類成員子句

- `(property [name Type])`
- `(method name ([p T] ...) to Ret in body)`
- `(constructor ([p T] ...) in body)`

## 13. 呼叫與物件操作

### 13.1 普通呼叫

```ironwall
(callee arg1 arg2 ...)
```

針對下列 builtin，frontend 還接受額外的 variadic surface sugar：

- `add` / `sub` / `mul` / `and` / `or` 可寫成 `>= 2` 參數；parser 會把它們收斂成右結合 binary tree

```ironwall
(add a b c d)
```

等價於：

```ironwall
(add a (add b (add c d)))
```

- `le` / `lt` / `ge` / `gt` / `eq` 可寫成 `>= 2` 參數；語義等價於 pairwise comparison chain，最後用右結合 `and` 連起來

```ironwall
(le a b c d)
```

等價於：

```ironwall
(and (le a b) (and (le b c) (le c d)))
```

- 這是 frontend sugar，不是額外的 runtime/builtin overload；因此 `0` / `1` 參數 form 仍然非法

### 13.2 建構物件

```ironwall
(class_new Point $1^i5 $2^i5)
```

### 13.3 欄位讀寫

```ironwall
(cm_get obj field)
(cm_set obj field expr)
```

- 只接受 `class_new` / `cm_get` / `cm_set` 這組物件 primitive。

詞法糖：

- `a.b.c` 等價於 `(cm_get (cm_get a b) c)`
- `a.b.c.d` 等價於 `(cm_get (cm_get (cm_get a b) c) d)`
- 每個 segment 必須是普通標識符或 package-qualified-name
- `a . b`、`a. b`、`a .b` 都非法，因為這個 sugar 必須在詞法上是一個無空格 raw chunk
- `a-b-c` 不是成員讀取語法。

## 14. Typed Literal / Reference

typed literal 與 typed database reference 只接受以下規範形狀：

```text
$payload^type
```

規則：

- `$42^i5`、`$3p14^f5`、`$hello^s3` 都是合法原子。
- 若需要 package-qualified database reference，必須寫成 `pkg$reference^ty`。
- `pkg$reference^ty` 只表示跨 package database reference，不表示 numeric literal。
- 因此 `a~b~d$banner^s3` 合法，但 `a~b~d$3p14^f5` 非法。

若短名 database reference 在可見 package 集中不唯一，必須改寫成 package-qualified database reference。

## 15. 陣列語法

- 內建陣列型別寫作 `<array T>`。
- 相關 builtin 調用形狀為：

```ironwall
(array_new <array T> len init)
(array_get xs idx)
(array_set xs idx value)
(array_length xs)
```

## 15. import

```ironwall
(import a~b~c)
```

- `import` 只能出現在 top-level。
- `import` 的目標是 package path，而非文件路徑。
