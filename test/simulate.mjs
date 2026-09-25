/**
 * 无头仿真测试：用 Node 模拟多个标签页 + BroadcastChannel + IndexedDB，
 * 逐条验证验收标准。消息以随机延迟、随机顺序投递（天然覆盖乱序场景）。
 *
 * 运行：node test/simulate.mjs
 */
import { CounterEngine } from '../js/crdt.js';

// 可复现的随机数
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const rng = makeRng(20260925);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 模拟 IndexedDB：同源共享的持久 Map，标签页关闭后数据仍在 */
const durableStore = new Map();

/** 模拟 BroadcastChannel：随机延迟异步投递，天然产生消息乱序 */
class Hub {
  constructor() {
    this.tabs = new Set();
    this.inFlight = 0;
  }
  connect(tab) { this.tabs.add(tab); }
  disconnect(tab) { this.tabs.delete(tab); }
  post(from, msg) {
    for (const tab of this.tabs) {
      if (tab === from || !tab.online) continue;
      this.inFlight++;
      const delay = Math.floor(rng() * 30); // 0-30ms 随机延迟 => 乱序
      setTimeout(() => {
        tab.receive(msg);
        this.inFlight--;
      }, delay);
    }
  }
  async drain() {
    while (this.inFlight > 0) await sleep(5);
    await sleep(20);
  }
}

/** 模拟一个标签页：引擎 + 本地持久写 + 收发消息（逻辑与 js/main.js 一致） */
class Tab {
  constructor(hub, tabId) {
    this.hub = hub;
    this.tabId = tabId;
    this.engine = new CounterEngine(tabId);
    this.online = true;
    this.pending = [];
    // 启动：从“IndexedDB”恢复 + 请求对账
    this.engine.loadOps([...durableStore.values()]);
    hub.connect(this);
    this.post({ kind: 'hello', tabId });
  }
  post(msg) { if (this.online) this.hub.post(this, msg); }
  receive(msg) {
    if (msg.tabId === this.tabId) return;
    if (msg.kind === 'op') {
      if (this.engine.applyRemote(msg.op)) durableStore.set(msg.op.id, msg.op);
    } else if (msg.kind === 'ops') {
      for (const op of msg.ops) {
        if (this.engine.applyRemote(op)) durableStore.set(op.id, op);
      }
    } else if (msg.kind === 'hello') {
      this.post({ kind: 'ops', tabId: this.tabId, ops: this.engine.getAllOps() });
    }
  }
  commit(op) {
    durableStore.set(op.id, op); // 先落库
    if (this.online) this.hub.post(this, { kind: 'op', tabId: this.tabId, op });
    else this.pending.push(op);
  }
  inc() { this.commit(this.engine.delta(1)); }
  dec() { this.commit(this.engine.delta(-1)); }
  reset() { this.commit(this.engine.reset()); }
  setTarget(v) { this.commit(this.engine.setTarget(v)); }
  goOffline() { this.online = false; }
  goOnline() {
    this.online = true;
    for (const op of this.pending.splice(0)) {
      this.hub.post(this, { kind: 'op', tabId: this.tabId, op });
    }
    this.post({ kind: 'hello', tabId: this.tabId });
  }
  close() { this.hub.disconnect(this); } // 数据已在 durableStore，直接断开
  get value() { return this.engine.getState().value; }
  get target() { return this.engine.getState().target; }
}

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name} ${detail}`); }
}
function assertConsistent(tabs, name) {
  const states = tabs.map((t) => `${t.value}/${t.target}`);
  check(name, new Set(states).size === 1, `状态不一致: ${states.join(' vs ')}`);
}

// ============ 场景 1：4 个标签页同时各加 100 次 ============
console.log('场景 1：4 标签页并发各 +100');
let hub = new Hub();
durableStore.clear();
let tabs = ['A', 'B', 'C', 'D'].map((id) => new Tab(hub, id));
await hub.drain();
// 交错并发执行，模拟“同时”操作
for (let i = 0; i < 100; i++) {
  for (const tab of tabs) {
    if (rng() < 0.5) await sleep(Math.floor(rng() * 3));
    tab.inc();
  }
}
await hub.drain();
assertConsistent(tabs, '所有标签页状态一致');
check('最终计数 = 400', tabs.every((t) => t.value === 400), `实际: ${tabs.map((t) => t.value)}`);

// ============ 场景 2：并发重置后最终为 0 ============
console.log('场景 2：4 标签页同时重置');
for (const tab of tabs) tab.reset(); // 同一事件循环内连续发出 = 并发
await hub.drain();
assertConsistent(tabs, '所有标签页状态一致');
check('最终计数 = 0', tabs.every((t) => t.value === 0), `实际: ${tabs.map((t) => t.value)}`);

// ============ 场景 3：重置与加减并发交错（乱序压力下仍收敛） ============
console.log('场景 3：重置与并发加减交错，验证收敛');
for (let i = 0; i < 50; i++) {
  for (const tab of tabs) (rng() < 0.5 ? tab.inc() : tab.dec());
  if (i === 20) tabs[0].reset();
  if (i === 25) tabs[2].reset();
}
await hub.drain();
assertConsistent(tabs, '乱序+并发重置下所有标签页收敛到同一值');

// ============ 场景 4：标签页关闭后计数不丢 ============
console.log('场景 4：关闭标签页后重开');
const before = tabs[0].value;
tabs[1].inc(); tabs[1].inc(); tabs[1].inc();
await hub.drain();
tabs[1].close(); // B 关闭
tabs[0].close(); // A 也关闭
const reopened = new Tab(hub, 'A2'); // 全新标签页从 IndexedDB 恢复
await hub.drain();
check('关闭后计数不丢', reopened.value === before + 3, `期望 ${before + 3}, 实际 ${reopened.value}`);
tabs = [tabs[2], tabs[3], reopened];

// ============ 场景 5：离线操作恢复后合并 ============
console.log('场景 5：离线操作恢复后合并');
const base = tabs[0].value;
tabs[0].goOffline();
for (let i = 0; i < 50; i++) tabs[0].inc(); // 离线期间本地 +50
for (let i = 0; i < 30; i++) tabs[1].inc(); // 其他标签页在线 +30
await hub.drain();
check('离线期间互不影响', tabs[1].value === base + 30 && tabs[2].value === base + 30);
tabs[0].goOnline(); // 恢复连接 => 双向合并
await hub.drain();
assertConsistent(tabs, '恢复后所有标签页一致');
check('离线 50 + 在线 30 全部合并', tabs.every((t) => t.value === base + 80),
  `期望 ${base + 80}, 实际: ${tabs.map((t) => t.value)}`);

// ============ 场景 6：刷新任意标签页后计数一致 ============
console.log('场景 6：刷新标签页（同 tabId 恢复）');
const beforeRefresh = tabs[0].value;
tabs[0].close();
const refreshed = new Tab(hub, tabs[0].tabId); // sessionStorage 保留 tabId
await hub.drain();
check('刷新后计数一致', refreshed.value === beforeRefresh, `期望 ${beforeRefresh}, 实际 ${refreshed.value}`);
tabs[0] = refreshed;

// ============ 场景 7：并发设置目标值（LWW 收敛） ============
console.log('场景 7：并发设置目标值');
tabs[0].setTarget(1000);
tabs[1].setTarget(2000);
tabs[2].setTarget(3000);
await hub.drain();
assertConsistent(tabs, '目标值收敛到同一赢家');
check('目标值非空', tabs.every((t) => typeof t.target === 'number'));

// ============ 场景 8：重复投递幂等（网络重发） ============
console.log('场景 8：消息重复投递不重复计数');
const dup = tabs[0].engine.delta(1);
tabs[0].commit(dup);
tabs[1].receive({ kind: 'op', tabId: tabs[0].tabId, op: dup }); // 手动重发
tabs[1].receive({ kind: 'op', tabId: tabs[0].tabId, op: dup });
await hub.drain();
assertConsistent(tabs, '重复投递后仍一致');
check('只计一次', tabs[1].value === beforeRefresh + 1, `实际 ${tabs[1].value}`);

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
