/**
 * 跨标签页计数器的核心同步引擎（纯逻辑，无浏览器 API 依赖，可在 Node 中测试）。
 *
 * 模型：op-log CRDT
 *  - 每个操作有全局唯一 id（`${tabId}:${seq}`）和 lamport 时钟。
 *  - delta（加一/减一）操作彼此可交换，按 id 去重，乱序/重复投递无害。
 *  - reset 是“纪元”标记：当前生效的 reset = (lamport, id) 字典序最大者；
 *    delta 携带产生时所属纪元的 resetId；计数值 = 当前纪元内所有 delta 之和。
 *    并发 reset 时所有标签页确定性地选出同一个赢家，旧纪元数据被丢弃。
 *  - target（目标值）使用 Last-Writer-Wins，按 (lamport, id) 比较。
 *
 * 收敛性：所有标签页最终持有相同的 op 集合，且 getState() 是集合上的
 * 确定性函数，因此无论消息顺序如何，最终状态必然一致。
 */

const GENESIS_RESET_ID = null;

export class CounterEngine {
  constructor(tabId) {
    this.tabId = tabId;
    this.seq = 0; // 本标签页操作序号（用于生成唯一 op id）
    this.lamport = 0;
    this.ops = new Map(); // opId -> op
    this.currentResetId = GENESIS_RESET_ID; // 本地已知的当前纪元
  }

  /** 本地 +amount，返回需要持久化并广播的 op */
  delta(amount) {
    const op = {
      type: 'delta',
      id: `${this.tabId}:${++this.seq}`,
      tabId: this.tabId,
      lamport: ++this.lamport,
      amount,
      resetId: this.currentResetId,
    };
    this._apply(op);
    return op;
  }

  /** 本地重置，返回需要持久化并广播的 op */
  reset() {
    const op = {
      type: 'reset',
      id: `${this.tabId}:${++this.seq}`,
      tabId: this.tabId,
      lamport: ++this.lamport,
    };
    this._apply(op);
    return op;
  }

  /** 本地设置目标值，返回需要持久化并广播的 op */
  setTarget(value) {
    const op = {
      type: 'target',
      id: `${this.tabId}:${++this.seq}`,
      tabId: this.tabId,
      lamport: ++this.lamport,
      value,
    };
    this._apply(op);
    return op;
  }

  /**
   * 合并一个（本地或远端）op。
   * 返回 true 表示是新 op；重复 op 被幂等忽略。
   */
  applyRemote(op) {
    if (!op || typeof op.id !== 'string' || this.ops.has(op.id)) return false;
    this.lamport = Math.max(this.lamport, op.lamport || 0);
    this._apply(op);
    return true;
  }

  /** 批量合并，返回新增 op 数量 */
  mergeOps(ops) {
    let added = 0;
    for (const op of ops) if (this.applyRemote(op)) added++;
    return added;
  }

  /** 从持久层恢复（启动/刷新时调用），同时重建 seq 与 lamport */
  loadOps(ops) {
    this.mergeOps(ops);
    for (const op of this.ops.values()) {
      if (op.tabId === this.tabId) {
        const n = Number(op.id.slice(op.id.lastIndexOf(':') + 1));
        if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
      }
    }
  }

  getAllOps() {
    return [...this.ops.values()];
  }

  _apply(op) {
    this.ops.set(op.id, op);
    if (op.type === 'reset') {
      const active = this._activeReset();
      this.currentResetId = active ? active.id : GENESIS_RESET_ID;
    }
  }

  _activeReset() {
    let best = null;
    for (const op of this.ops.values()) {
      if (op.type !== 'reset') continue;
      if (
        !best ||
        op.lamport > best.lamport ||
        (op.lamport === best.lamport && op.id > best.id)
      ) {
        best = op;
      }
    }
    return best;
  }

  /** 当前状态：{ value, target }，是 op 集合上的确定性函数 */
  getState() {
    const active = this._activeReset();
    const activeId = active ? active.id : GENESIS_RESET_ID;

    let value = 0;
    let target = null;
    let targetWinner = null;

    for (const op of this.ops.values()) {
      if (op.type === 'delta' && (op.resetId ?? GENESIS_RESET_ID) === activeId) {
        value += op.amount;
      } else if (op.type === 'target') {
        if (
          !targetWinner ||
          op.lamport > targetWinner.lamport ||
          (op.lamport === targetWinner.lamport && op.id > targetWinner.id)
        ) {
          targetWinner = op;
          target = op.value;
        }
      }
    }
    return { value, target };
  }
}
