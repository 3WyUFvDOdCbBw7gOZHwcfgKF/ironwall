# Ironwall 型别系统规格

本文定义 Ironwall 的型别构成、型别相等、可赋值关系，以及泛型与联合型别的收束规则。

## 1. 原始型别

primitive type 名单如下：

- 有号整数：`i5`、`i6`、`i7`
- 无号整数：`u5`、`u6`、`u7`
- 浮点：`f5`、`f6`、`f7`
- 复数：`z5`、`z6`、`z7`
- 字元：`c3`、`c4`、`c5`
- 字串：`s3`、`s4`、`s5`
- 其他：`bool`、`unit`

命名惯例为「前缀字母 + 指数 `n`」，其设计意图是用 `2^n` 表示位宽等级；型别相等仍只看型别名本身。

## 2. 类型别

### 2.1 普通类

- 每个 top-level `class` 形成一个 nominal type。
- 类型别以类名识别，不采结构相等。

### 2.2 泛型类实例

- `<Pair i5 s3>`、`<Node i5>` 这类显式实例化结果形成 concrete type。
- 泛型类实例仍是 nominal type，型别名与全部 type arguments 都必须一致。

### 2.3 内建泛型型别

的内建 generic type 为：

- `<array T>`

`array` 是 builtin runtime type，不是用户定义 `class`。

## 3. 函数型别

函数型别写作：

```ironwall
<to Ret from T1 T2 ...>
```

规则：

- 参数数量、参数顺序、每个参数型别、返回型别都参与型别相等。
- 无参数函数仍属函数型别的一种情况。

## 4. 联合型别

联合型别写作：

```ironwall
<union T1 T2 ...>
```

收束规则：

- 联合成员在型别层会 canonicalize。
- 巢状 union 不会被展平；巢状 union 会保留为直接成员型别。
- 重复的直接成员是型别错误，必须直接拒绝，不得静默去重。
- 成员顺序不影响最终型别相等。
- union 里每个直接成员类型必须在该 union 里唯一。


因此以下型别必须视为相等：

- `<union i5 f5>`
- `<union f5 i5>`

以下型别会保留巢状 union 结构，因此与上述两者不同：

- `<union i5 <union f5 i5>>`

以下型别非法，因为 `i5` 作为直接成员出现两次：

- `<union i5 f5 i5>`

## 5. 型别相等

### 5.1 primitive

- 型别名完全一致才相等。

### 5.2 class

- 类名完全一致才相等。

### 5.3 generic class / generic function instance

- generic name 相同且 type arguments 全部 pairwise 相等才相等。

### 5.4 function type

- 参数个数相同。
- 参数顺序相同。
- 对应参数型别相等。
- 返回型别相等。

### 5.5 union type
- 经 canonicalization 后，成员序列完全一致才相等。
- canonicalization 只会为型别相等排序直接成员，不会展平巢状 union。

## 6. 可赋值关系

`isAssignable` 规则很保守：

- 若 `actual` 与 `expected` 型别相等，则可赋值。
- 若 `expected` 是 union，且 `actual` 与某一成员型别相等，则可赋值。
- 除此之外，不定义其他隐式可赋值关系。

这代表：

- `i5` 值可直接作为 `<union i5 f5>` 的成员值使用
- `i5` 不可隐式转成 `f5`
- `<union i5 f5>` 不可隐式缩成 `i5`

## 7. 泛型

### 7.1 支持范围

- 支持泛型类
- 支持泛型函数
- 不支持泛型 `declare`
- 不支持 type alias

### 7.2 显式优先

- 泛型实例化必须显式写出全部 type arguments。
- 不提供根据实参自动补全 type arguments 的语言级推断。
- 泛型函数名本身不能裸作值使用，必须先显式实例化。

## 8. 显式标注要求

以下位置都必须写出显式型别：

- `[name Type]` 绑定
- 函数参数
- 函数返回型别
- 类属性
- top-level global

额外限制：

- top-level global 的宣告型别必须是 primitive type，或是至少含有一个 primitive member 的 union。
- top-level global initializer 的最终值必须是一个可赋值到该型别的 primitive payload。

不允许：

- 省略 `let` / `var` 绑定型别
- 省略函数返回型别
- 省略属性型别

## 9. 数值型别规则

- 不存在预设整数型别或预设浮点型别。
- 数值字面量必须写成 typed literal。
- 不存在 `i5 -> f5`、`f5 -> f6`、`i5 -> i6` 等隐式数值提升。
- 算术与比较 builtin 的可用签名由 builtin 规格决定，而不是由隐式转换补齐。

## 10. `unit`

- `unit` 同时是 primitive type 与其唯一值的拼写。
- `unit` 常用于副作用流程、空结果、`<union unit T>` 与其他 union 类型的空分支。

## 11. 类型别名禁令

- 严格禁止 `type alias`。

## 12. 重载

- 函数通过，函数名和参数的唯一性进行重载。
- 泛型类，和泛型函数，通过泛型名字和泛型参数数量的唯一性进行重载。
