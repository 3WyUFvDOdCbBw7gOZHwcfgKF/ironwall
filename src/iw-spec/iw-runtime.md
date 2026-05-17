# Ironwall Runtime 規格

本文定義 Ironwall 的 runtime 立場與 GC 路線。它是執行時層的原則文件，而不是任何具體實作方案的說明。與具體部署條件有關的內容，只作設計取向，不作語言義務。

## 1. Runtime 憲法

Ironwall runtime 的首要任務不是追求「看起來沒有停頓」，而是建立更小、更硬、更可審計的攻擊面。

其最高原則如下：

- 防禦 RCE 高於性能宣傳。
- 複雜度就是漏洞面。
- 寧可接受顯式停頓，也不接受隱式複雜協議。
- GC 相關優化應優先改善程式平時執行時的速度與安全，而不是優先縮短 GC 停頓。

Ironwall 的 runtime 路線不是「無感、並發、增量」，而是「簡單、暴力、隔離」。

## 2. 硬體與資源立場

Ironwall 不以「記憶體極度稀缺」作為默認時代背景。

其基本判斷是：

- 在現代硬體條件下，記憶體冗餘首先應被視為安全緩衝，而不是只被視為必須榨乾的昂貴資源。
- 若為了省幾 MB 記憶體而把 runtime 變成更複雜、更脆弱、更難審計的系統，通常是錯誤交換。

這不表示記憶體可以無限制浪費，而是表示：

- runtime 應優先用空間換簡單性與安全性。
- 不應為了表面節省記憶體而回到高風險手動管理模型。

## 3. GC 路線

### 3.1 回收器類型

- 採極簡 `Mark-Sweep` 回收器。
- 回收模型是：標記可達對象，掃除未標記堆塊。

### 3.2 Stop-The-World

- 回收時必須採 Stop-The-World。
- 不引入 concurrent GC、incremental GC、generational GC。
- 不引入讀寫屏障、寫入屏障、三色標記協議或其他回收屏障協議。

### 3.3 觸發方式

- GC 的觸發方式必須是手動。
- Runtime 不得把 GC 設計成隱式、背景、自作主張的回收機制。
- 程式本身可以顯式觸發 GC。
- 程式的調用者也可以顯式觸發 GC。

這是 Ironwall 的硬立場，不是暫時實作選擇。理由很直接：

- GC 何時發生，必須是可預期、可觀察、可審計的。
- 一旦把觸發權交給隱式 runtime 啟發式，整個系統的時序與安全邊界就會變得模糊。
- Ironwall 寧可接受顯式 `gc_collect`，也不接受「平常看不見，但隨時可能插進來」的隱式回收。

## 4. 為什麼拒絕複雜 GC

Ironwall 對複雜 GC 技術的立場很明確：

- 並發 GC 會把回收協議滲透到整個平時執行路徑。
- barrier、並發標記、讀寫同步、狀態機切換都會顯著擴大可信邊界。
- 一旦回收正確性建立在更複雜的競態協議上，攻擊面與審計成本都會急速上升。

因此，Ironwall 不把「更少停頓」視為足以壓過這些代價的理由。

## 5. 顯式回收入口

- 顯式回收入口若公開為 base-lib 函數，它必須是普通函數，不是語法關鍵字。

其規範性要求如下：

- 它必須是一個顯式回收入口。
- 一旦被公開為語言可見 API，程式內部可以呼叫它。
- 程式外部的調用者也可以透過宿主介面觸發同等語義的顯式回收。
- 它不得被偽裝成隱式背景策略的包裝門面。

Ironwall 在這一點上的立場很硬：

- GC 不是「runtime 自己看著辦」的隱藏機制。
- GC 必須是顯式控制的一部分。
- 程式作者與調用者都必須有能力在語義上要求一次明確回收。

## 6. 安全邊界

Ironwall runtime 明確拒絕以下方向：

- 把 GC correctness 建立在複雜競態協議上
- 把 hidden safepoint 與隱式 barrier 擴散到普通執行路徑
- 為了縮短停頓而增加大面積隱式回收狀態追蹤
- 為了局部 benchmark 指標而放鬆整體可信邊界

Runtime 的基本要求不是「聰明」，而是：

- 誠實
- 可審計
- 可解釋
- 失敗模式清楚

## 7. GC Metadata 與 Table Identity

### 7.1 per-unit metadata table

- 在支持分開文件編譯的實作中，每個源單元都可以獨立產生自己的 GC metadata table 與 global var table。
- metadata table 不是語義上必須被壓平成「全程序單一平面表」的東西；編譯單元邊界屬於 runtime 可見身份的一部分。
- 每個 metadata table 必須帶一個 deterministic UUID。
- 每個 heap object / shadow frame / global aggregate 對應的 metadata entry，也必須帶一個 deterministic struct UUID。
- 這個 UUID 的作用是標識「這是哪一張 metadata table」，不是拿來取代具體 layout tag。

### 7.2 tagged block 的驗證鍵

- heap object、shadow frame、以及帶 GC shape 的 global aggregate block，GC-visible prefix 都必須攜帶三個 64-bit tag：`tag1`、`tag2`、`tag3`。
- `tag1` 的高 48 位是 struct UUID 的獨立 48-bit hash，低 16 位是對這 48 位做出的 confirmation hash；runtime 必須先驗這 16 位，才能把它視為「很可能是結構開頭」。
- `tag2` 是 struct UUID 的獨立 64-bit hash；`tag3` 是 metadata table UUID 的 64-bit hash。
- runtime 驗證時，必須先以 `tag1` 在 metadata table collection 中找 candidate table，再以 `tag3` 排除跨 table collision；找到 table 之後，再以 `tag1` 找 candidate entry，並以 `tag2` 排除 table 內 collision。
- runtime 不得假設 `tag1` 在所有 metadata table 或同一張 table 內天然唯一；`tag2` / `tag3` 是正式的 collision disambiguator，不是可有可無的 debug 欄位。

### 7.3 collection model

- 分開編譯後的整合結果，必須暴露 metadata table collection 與 global var table collection。
- collector 對 global roots 的列舉、對 metadata 的查找、以及對 GC-visible block 的驗證，都必須以這兩個 collection 為權威來源。
- 載入順序或內部暫存順序，都不得充當 table identity 或 root 枚舉來源。

## 8. Separate Compilation 與 GC

- 一個 separately compiled unit 即使最後只提供部分 global 或部分 layout，也仍然應保留自己的 table identity，而不是在 link/整合時把 provenance 抹平。
- link/整合階段可以把多張 per-unit table 收束成 collection，但不得把「屬於哪個 metadata table」這個資訊從 heap/global 驗證鏈中刪掉。
- 若某個 unit 最終沒有任何 GC-visible layout 或 global，實作可以把它對應的 table 做成空表；但這不改變前述 identity/collection 模型。

### 8.1 precompiled lib packaging 與 unit identity

- 把 separately compiled module 打包成 `.tgz` precompiled lib，不得改寫其中 unit 的 runtime identity。
- archive 的 manifest 與 per-unit artifacts 只是交付形態；GC runtime 真正看到的 per-unit metadata table / global table identity，仍然必須對齊原本的 unit 邊界。
- 每個 packaged unit 都必須保留自己的 `metadataTableExportSymbol`、`globalTableExportSymbol`、`runtimeInitExportSymbol`。
- runtime/link 初始化 imported lib 時，必須呼叫每個 linked unit 的 `runtimeInitExportSymbol`，先把該 unit 的 table 與 global block 掛入 collection，再執行該 unit 的 top-level init body。
- archive 載入順序、tgz 內文件順序、或 per-unit artifact 的展開順序，都不得參與 metadata table identity 的決定。
