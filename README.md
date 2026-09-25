# 跨标签页共享计数器

多个浏览器标签页共享同一个计数器，支持 **+1 / −1 / 重置 / 设置目标值**。
并发操作最终一致，不丢更新。

## 运行

```bash
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000 ，再复制 URL 多开几个标签页
```

（IndexedDB 在 `file://` 下行为受限，请通过 http 访问。）

## 自动化测试

无需浏览器，Node ≥ 18 直接运行仿真测试（模拟 4 个标签页、随机乱序投递）：

```bash
node test/simulate.mjs
```

覆盖：4 标签页各 +100 → 400、并发重置 → 0、关闭/刷新不丢、离线恢复合并、
乱序收敛、目标值 LWW、重复消息幂等。

## 设计：op-log CRDT

核心代码在 `js/crdt.js`，是无浏览器依赖的纯模块，页面和测试共用同一套逻辑。

- **操作即事件**：每次 +1/−1/重置/设目标都生成一条 op，含全局唯一 id
  （`tabId:seq`）和 lamport 时钟。
- **加/减不丢更新**：delta 操作天然可交换，按 id 幂等去重。状态是 op
  集合的确定性折叠函数，消息乱序、重复投递、延迟到达都不影响最终结果。
- **重置 = 纪元切换**：当前生效的 reset 是 `(lamport, id)` 最大的那条；
  delta 携带产生时所属的 `resetId`，计数值 = 当前纪元内 delta 之和。
  并发重置时所有标签页确定性地选出同一个赢家，重置前的数据被丢弃，
  最终必然收敛到 0（或重置后的新增量）。
- **目标值**：Last-Writer-Wins，同样按 `(lamport, id)` 比较。
- **持久化（IndexedDB）**：op **先写库再广播**，标签页关闭、崩溃、刷新
  都不丢数据；启动时从库中重建整个 op-log。
- **同步（BroadcastChannel）**：
  - 单条新 op 实时广播 `{kind:'op'}`；
  - 新标签页上线或离线恢复时发 `hello`，其他标签页全量回发 `ops`，
    接收方按 id 去重合并——全量对账保证任何漏收都能补齐。
- **离线**：页面上“模拟离线”断开频道（也响应浏览器 offline/online 事件），
  离线期间 op 照常写 IndexedDB 并入队；恢复后补发队列 + 全量对账，双向合并。

### 关于 Web Worker

需求中为可选项，未使用。同步逻辑已收敛到纯函数模块，BroadcastChannel
与 IndexedDB 的 I/O 量极小（每条 op 一条消息/一次主键写入），主线程
完全够用；如未来需要在 worker 中跑，可直接复用 `js/crdt.js`。

## 文件

- `index.html` / `style.css` — 页面与样式
- `js/crdt.js` — 同步引擎（纯逻辑，核心）
- `js/store.js` — IndexedDB 封装
- `js/main.js` — BroadcastChannel 同步 + UI 接线
- `test/simulate.mjs` — 多标签页并发仿真测试
