# Ironwall 核心语义规格

本文描述 Ironwall 的核心语义，包括作用域、求值规则、可变性、类与阵列的约束，以及错误模型。

## 1. 总体原则

- 显式优先于隐式。
- 可静态分析优先于语法糖堆叠。
- 安全与可审计优先于复杂的隐式行为。
- 不提供语言级异常系统。

## 2. 作用域与名字解析

核心表达式内部的名字解析顺序为：

1. 局部词法作用域
2. 本 package 的 top-level 名字
3. imported package 的 top-level 名字（包含显式导入的 `std~...` package 名字）
4. 语言 builtin 名字

模组层更细的 package 规则由模组规格定义。

## 3. 可变性

### 3.1 可变绑定

以下绑定在语义上可被 `var_set` 修改：

- `var` 引入的局部变量
- `let` 绑定
- 对当前 unit 可见的 top-level global

### 3.2 不可变绑定

以下绑定为 immutable：

- `fn` / `function` 参数
- 类方法与 constructor 中的参数
- `self`

对 immutable 绑定执行 `var_set` 必须报错。

## 4. `let` 的可见性

- `let` 绑定按照书写顺序由左到右生效。
- 普通绑定值不能前向引用后面的普通绑定。
- 若某绑定值本身是 `fn`，则该 `fn` 可参与局部递回函数集合。
- 即使在局部递回情况下，普通非函数绑定仍维持 prefix-visible 规则。

## 5. 控制流

### 5.1 `if`

- `cond` 必须是 `bool`
- `then` 与 `else` 分支型别必须一致
- 只求值被选中的分支

### 5.2 `while`

- `condition` 必须是 `bool`
- 每轮先测试条件，再执行 body
- `while` 整体型别固定为 `unit`

### 5.3 `cond`

- `else` 必须存在且必须是最后一支
- 非 `else` 条件都必须是 `bool`
- 所有分支结果型别必须一致

### 5.4 block

- `{e1 ... eN}` 依书写顺序求值
- block 的值为最后一个表达式的值

## 6. 联合与 `match`

### 6.1 union 成员提升

- 若 `T` 是 `<union ...>` 的成员，则 `T` 值可直接赋给该 union 型别。
- union 运行时必须携带 tag。

### 6.2 `match`

- 被匹配值必须是 union 型别。
- 分支集合必须穷尽覆盖所有 union 成员型别。
- 每个分支 bind 上的型别必须对应某个 union 成员。
- 各分支 body 的结果型别必须一致。
- 若某个 union 成员本身也是 union，外层 `match` 会绑定该巢状 union 值；必须再用第二层 `match` 才能检查巢状 union 自己的 runtime tag 与 payload。

若值不满足 `match` 的型别前提，属不可恢复失败。

## 7. 类与物件

### 7.1 类的基本约束

- 每个类必须有constructor,可以用多个constructor, 通过参数唯一性来进行重载。
- property 名称在类内必须唯一。
- method 名称在类内必须唯一。
- property 与 method 不可同名。
- 不支持继承。
- 未标记 `public` 的 property / method 默认为 private。
- `(public ...)` 只可标记 property / method；constructor 默认 public。
- 普通 class 与 generic class 遵守相同的成员可见性规则。

### 7.2 constructor 约束

- constructor 必须初始化所有 property。
- constructor 不得在 property 尚未初始化时读取该 property。
- 透过 method 间接读取 property 时，也必须满足初始化顺序要求。

### 7.3 `self`

- `self` 只在 method 与 constructor 内自动绑定。
- `self` 是 immutable 绑定，但其栏位可透过 `cm_set` 被初始化或修改。

### 7.4 成员可见性

- class 外部透过 `cm_get`、member-chain sugar 或方法值取得，只能读取 public property / method。
- class 外部透过 `cm_set` 只能写入 public property。
- class 的 method / constructor 内部可透过 `self` 读写同一 class 的 private property，并可读取同一 class 的 private method。
- generic class 实例化后仍保留来源 generic class 的 property / method 可见性。
- 对 private 成员的外部访问必须作为静态错误拒绝。

## 8. 阵列

- `<array T>` 是定长阵列。
- `array_get` / `array_set` 必须做越界检查。
- `array_length` 返回 `i5`。
- 若某 class 被 `array_new` 当作元素型别批量建立，则该 class 必须具备零参数 constructor。 这样才能通过zero-arg constructor 来建数组。

## 9. Top-level global

- top-level `var` 在 module mode 下表示 global。
- global 必须显式型别并带初始化式。
- global 型别必须是 primitive type，或是至少包含一个 primitive member 的 union。
- global initializer 必须由静态语义决定为 primitive payload。
- global initializer 不得读取其他 global，也不得呼叫 user-defined function / generic function / `declare`。
- global initializer 只允许落在 static primitive subset 内的控制流与 builtin。
- 只要某个 global 对当前 unit 可见，该 global 就可读可写；短名路径仍需遵守 import 可见性规则。

更细的 module-level global 规则由模组规格定义。

## 10. 错误模型

### 10.1 静态错误

以下属静态诊断：

- 词法错误
- 语法错误
- 型别错误
- 名字解析歧义
- 非法 top-level 结构
- global init cycle
- 对 immutable 绑定赋值

### 10.2 运行时失败

以下属不可恢复运行时失败：

- 阵列越界
- union tag 非法
- 内建前提被破坏
- 违反执行前提的其他不可恢复失败

### 10.3 异常禁令

- 语言层不提供 `throw`、`try`、`catch`。
- 可恢复失败应由 union 或其他显式资料模型建模。
