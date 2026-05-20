# Ironwall 语法规格

本文描述 Ironwall 的核心语法形状。它只回答「怎么写」，不重复展开完整型别与模组语义；后者由型别、语义与模组规格分别定义。

## 1. 根结构

- 每个 module-mode `.iw` 源单元必须且只能有一个根块：`{program <unit-id> ...}`。
- `program` 只能出现在根位置，不能巢状出现在其他表达式中。
- `unit-id` 的规范形状为 `<package-path>@<unit-name>`。

示例：

```ironwall
{program app~cli@main
  (function main ([args <array s3>]) to i5 in $0^i5)
}
```

## 2. 关键字

核心语法使用以下保留的语法词：

- `program`
- `import`
- `var`
- `var_set`
- `fn`
- `function`
- `declare`
- `let`
- `in`
- `if`
- `then`
- `else`
- `while`
- `cond`
- `match`
- `class`
- `property`
- `method`
- `constructor`
- `generic`
- `to`
- `from`
- `union`

语言 builtin 名字与 package 导出名字由 builtin 与模组规格分别定义，不在本节重复列出。

## 3. 绑定语法

绑定位置统一使用：

```ironwall
[name Type]
```

规则：

- `name` 必须是普通标识符。
- `Type` 必须明确写出。
- `[x]`、`[x _]` 之类省略型别的写法非法。

## 4. 区块与顺序

### 4.1 `{...}` block

```ironwall
{e1 e2 ... eN}
```

- 表示顺序求值区块。
- 返回最后一个表达式的值。
- 空 block 非法。

## 5. 变量与赋值

### 5.1 `var`

```ironwall
(var [x T] expr)
```

- 建立一个具名绑定并初始化。
- `var` 同时用于局部变量与 top-level global。

### 5.2 `var_set`

```ironwall
(var_set x expr)
```

- 对既有绑定重新赋值。
- 对物件栏位赋值不走 `var_set`，而走 `cm_set` builtin。

## 6. 函数

### 6.1 匿名函数 `fn`

```ironwall
(fn ([p1 T1] [p2 T2] ...) to Ret in body)
```

- `fn` 是一等值。
- 参数列表与返回型别都必须显式写出。

### 6.2 具名函数 `function`

```ironwall
(function name ([p1 T1] ...) to Ret in body)
```

- `function` 必须出现在 top-level。
- 同名具名函数可依参数型别形成 overload set。

### 6.3 `declare`

```ironwall
(declare (function name ([p1 T1] ...) to Ret))
```

- 宣告外部函数签名，不提供 Ironwall 函数体。
- `declare` 只能出现在 top-level。

## 7. `let`

```ironwall
(let (([x T] e1) ([y U] e2) ...) in body)
```

- 绑定列表写在双层括号中。
- 每个绑定都必须带显式型别。
- `let` body 只有一个主体表达式。

## 8. 条件与回圈

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

- `else` 分支必须位于最后。

## 9. 型别语法

### 9.1 函数型别

```ironwall
<to Ret from T1 T2 ...>
```

### 9.2 联合型别

```ironwall
<union T1 T2 ...>
```

- union 型别必须包含唯一的直接成员型别。
- 重复的直接成员会在型别验证时被拒绝，而不是被去重。
- 允许巢状 union 语法；它表示一个巢状 union 成员，不表示展开后的成员列表。

### 9.3 泛型名

```ironwall
<generic Name T1 T2 ...>
```

- 该形状只用于宣告 generic class / generic function 的头部。

## 10. 泛型宣告与实例化

### 10.1 泛型函数宣告

```ironwall
(function <generic id T> ([x T]) to T in x)
```

### 10.2 泛型类宣告

```ironwall
(class <generic Box T>
  (property [value T])
  (constructor ([v T]) in (cm_set self value v))
)
```

### 10.3 显式实例化

```ironwall
<id i5>
(<id i5> $42^i5)
<Box i5>
```

- `<name T...>` 表示对 generic name 显式套用型别参数。
- 若外层再包一层 `(...)`，则表示对实例化结果做呼叫。

## 11. `match`

```ironwall
(match value
  ([x T1] body1)
  ([y T2] body2)
  ...
)
```

- 每个分支都以一个 typed bind 开头。

## 12. 类

### 12.1 类宣告

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

### 12.2 类成员子句

- `(property [name Type])`
- `(method name ([p T] ...) to Ret in body)`
- `(constructor ([p T] ...) in body)`

## 13. 呼叫与物件操作

### 13.1 普通呼叫

```ironwall
(callee arg1 arg2 ...)
```

针对下列 builtin，frontend 还接受额外的 variadic surface sugar：

- `add` / `mul` / `and` / `or` 可写成 `>= 2` 参数；parser 会把它们收敛成右结合 binary tree
- `sub` 也可写成 `>= 2` 参数，但 parser 会把它收敛成左结合 binary tree

```ironwall
(add a b c d)
```

等价于：

```ironwall
(add a (add b (add c d)))
```

```ironwall
(sub a b c d)
```

等价于：

```ironwall
(sub (sub (sub a b) c) d)
```

- `le` / `lt` / `ge` / `gt` / `eq` 可写成 `>= 2` 参数；语义等价于 pairwise comparison chain，最后用右结合 `and` 连起来

```ironwall
(le a b c d)
```

等价于：

```ironwall
(and (le a b) (and (le b c) (le c d)))
```

- 这是 frontend sugar，不是额外的 runtime/builtin overload；因此 `0` / `1` 参数 form 仍然非法

### 13.2 建构物件

```ironwall
(class_new Point $1^i5 $2^i5)
```

### 13.3 栏位读写

```ironwall
(cm_get obj field)
(cm_set obj field expr)
```

- 只接受 `class_new` / `cm_get` / `cm_set` 这组物件 primitive。

词法糖：

- `a.b.c` 等价于 `(cm_get (cm_get a b) c)`
- `a.b.c.d` 等价于 `(cm_get (cm_get (cm_get a b) c) d)`
- 每个 segment 必须是普通标识符或 package-qualified-name
- `a . b`、`a. b`、`a .b` 都非法，因为这个 sugar 必须在词法上是一个无空格 raw chunk
- `a-b-c` 不是成员读取语法。

## 14. Typed Literal / Reference

typed literal 与 typed database reference 只接受以下规范形状：

```text
$payload^type
```

规则：

- `$42^i5`、`$3p14^f5`、`$hello^s3` 都是合法原子。
- 若需要 package-qualified database reference，必须写成 `pkg$reference^ty`。
- `pkg$reference^ty` 只表示跨 package database reference，不表示 numeric literal。
- 因此 `a~b~d$banner^s3` 合法，但 `a~b~d$3p14^f5` 非法。

若短名 database reference 在可见 package 集中不唯一，必须改写成 package-qualified database reference。

## 15. 阵列语法

- 内建阵列型别写作 `<array T>`。
- 相关 builtin 调用形状为：

```ironwall
(array_new <array T> len init)
(array_get xs idx)
(array_set xs idx value)
(array_length xs)
```

## 16. import

```ironwall
(import a~b~c)
```

- `import` 只能出现在 top-level。
- `import` 的目标是 package path，而非文件路径。
