# Ironwall Runtime 规格

本文定义 Ironwall 的 runtime 立场与 GC 路线。它是执行时层的原则文件，而不是任何具体实作方案的说明。与具体部署条件有关的内容，只作设计取向，不作语言义务。

## 1. Runtime 宪法

Ironwall runtime 的首要任务不是追求「看起来没有停顿」，而是建立更小、更硬、更可审计的攻击面。

其最高原则如下：

- 防御 RCE 高于性能宣传。
- 复杂度就是漏洞面。
- 宁可接受显式停顿，也不接受隐式复杂协议。
- GC 相关优化应优先改善程式平时执行时的速度与安全，而不是优先缩短 GC 停顿。

Ironwall 的 runtime 路线不是「无感、并发、增量」，而是「简单、暴力、隔离」。

## 2. 硬体与资源立场

Ironwall 不以「记忆体极度稀缺」作为默认时代背景。

其基本判断是：

- 在现代硬体条件下，记忆体冗余首先应被视为安全缓冲，而不是只被视为必须榨干的昂贵资源。
- 若为了省几 MB 记忆体而把 runtime 变成更复杂、更脆弱、更难审计的系统，通常是错误交换。

这不表示记忆体可以无限制浪费，而是表示：

- runtime 应优先用空间换简单性与安全性。
- 不应为了表面节省记忆体而回到高风险手动管理模型。

## 3. GC 路线

### 3.1 回收器类型

- 采极简 `Mark-Sweep` 回收器。
- 回收模型是：标记可达对象，扫除未标记堆块。

### 3.2 Stop-The-World

- 回收时必须采 Stop-The-World。
- 不引入 concurrent GC、incremental GC、generational GC。
- 不引入读写屏障、写入屏障、三色标记协议或其他回收屏障协议。

### 3.3 触发方式

- GC 的触发方式必须是手动。
- Runtime 不得把 GC 设计成隐式、背景、自作主张的回收机制。
- 程式本身可以显式触发 GC。
- 程式的调用者也可以显式触发 GC。

这是 Ironwall 的硬立场，不是暂时实作选择。理由很直接：

- GC 何时发生，必须是可预期、可观察、可审计的。
- 一旦把触发权交给隐式 runtime 启发式，整个系统的时序与安全边界就会变得模糊。
- Ironwall 宁可接受显式 `gc_collect`，也不接受「平常看不见，但随时可能插进来」的隐式回收。

## 4. 为什么拒绝复杂 GC

Ironwall 对复杂 GC 技术的立场很明确：

- 并发 GC 会把回收协议渗透到整个平时执行路径。
- barrier、并发标记、读写同步、状态机切换都会显著扩大可信边界。
- 一旦回收正确性建立在更复杂的竞态协议上，攻击面与审计成本都会急速上升。

因此，Ironwall 不把「更少停顿」视为足以压过这些代价的理由。

## 5. 显式回收入口

- 显式回收入口若公开为 base-lib 函数，它必须是普通函数，不是语法关键字。

其规范性要求如下：

- 它必须是一个显式回收入口。
- 一旦被公开为语言可见 API，程式内部可以呼叫它。
- 程式外部的调用者也可以透过宿主介面触发同等语义的显式回收。
- 它不得被伪装成隐式背景策略的包装门面。

Ironwall 在这一点上的立场很硬：

- GC 不是「runtime 自己看着办」的隐藏机制。
- GC 必须是显式控制的一部分。
- 程式作者与调用者都必须有能力在语义上要求一次明确回收。

## 6. 安全边界

Ironwall runtime 明确拒绝以下方向：

- 把 GC correctness 建立在复杂竞态协议上
- 把 hidden safepoint 与隐式 barrier 扩散到普通执行路径
- 为了缩短停顿而增加大面积隐式回收状态追踪
- 为了局部 benchmark 指标而放松整体可信边界

Runtime 的基本要求不是「聪明」，而是：

- 诚实
- 可审计
- 可解释
- 失败模式清楚

## 7. GC Metadata 与 Table Identity

### 7.1 per-unit metadata table

- 在支持分开文件编译的实作中，每个源单元都可以独立产生自己的 GC metadata table 与 global var table。
- metadata table 不是语义上必须被压平成「全程序单一平面表」的东西；编译单元边界属于 runtime 可见身份的一部分。
- 每个 metadata table 必须带一个 deterministic UUID。
- 每个 heap object / shadow frame / global aggregate 对应的 metadata entry，也必须带一个 deterministic struct UUID。
- 这个 UUID 的作用是标识「这是哪一张 metadata table」，不是拿来取代具体 layout tag。

### 7.2 tagged block 的验证键

- heap object、shadow frame、以及带 GC shape 的 global aggregate block，GC-visible prefix 都必须携带三个 64-bit tag：`tag1`、`tag2`、`tag3`。
- `tag1` 的高 48 位是 struct UUID 的独立 48-bit hash，低 16 位是对这 48 位做出的 confirmation hash；runtime 必须先验这 16 位，才能把它视为「很可能是结构开头」。
- `tag2` 是 struct UUID 的独立 64-bit hash；`tag3` 是 metadata table UUID 的 64-bit hash。
- runtime 验证时，必须先以 `tag1` 在 metadata table collection 中找 candidate table，再以 `tag3` 排除跨 table collision；找到 table 之后，再以 `tag1` 找 candidate entry，并以 `tag2` 排除 table 内 collision。
- runtime 不得假设 `tag1` 在所有 metadata table 或同一张 table 内天然唯一；`tag2` / `tag3` 是正式的 collision disambiguator，不是可有可无的 debug 栏位。

### 7.3 collection model

- 分开编译后的整合结果，必须暴露 metadata table collection 与 global var table collection。
- collector 对 global roots 的列举、对 metadata 的查找、以及对 GC-visible block 的验证，都必须以这两个 collection 为权威来源。
- 载入顺序或内部暂存顺序，都不得充当 table identity 或 root 枚举来源。

## 8. Separate Compilation 与 GC

- 一个 separately compiled unit 即使最后只提供部分 global 或部分 layout，也仍然应保留自己的 table identity，而不是在 link/整合时把 provenance 抹平。
- link/整合阶段可以把多张 per-unit table 收束成 collection，但不得把「属于哪个 metadata table」这个资讯从 heap/global 验证链中删掉。
- 若某个 unit 最终没有任何 GC-visible layout 或 global，实作可以把它对应的 table 做成空表；但这不改变前述 identity/collection 模型。

### 8.1 precompiled lib packaging 与 unit identity

- 把 separately compiled module 打包成 `.tgz` precompiled lib，不得改写其中 unit 的 runtime identity。
- archive 的 manifest 与 per-unit artifacts 只是交付形态；GC runtime 真正看到的 per-unit metadata table / global table identity，仍然必须对齐原本的 unit 边界。
- 每个 packaged unit 都必须保留自己的 `metadataTableExportSymbol`、`globalTableExportSymbol`、`runtimeInitExportSymbol`。
- runtime/link 初始化 imported lib 时，必须呼叫每个 linked unit 的 `runtimeInitExportSymbol`，先把该 unit 的 table 与 global block 挂入 collection，再执行该 unit 的 top-level init body。
- archive 载入顺序、tgz 内文件顺序、或 per-unit artifact 的展开顺序，都不得参与 metadata table identity 的决定。
