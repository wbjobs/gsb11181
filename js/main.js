import { CounterEngine } from './crdt.js';
import { openStore } from './store.js';

const CHANNEL_NAME = 'shared-counter-v1';

// tabId 存 sessionStorage：刷新后身份不变（op id 连续），新标签页生成新 id。
const tabId =
  sessionStorage.getItem('counter-tab-id') ||
  (() => {
    const id = crypto.randomUUID();
    sessionStorage.setItem('counter-tab-id', id);
    return id;
  })();

const engine = new CounterEngine(tabId);
const store = await openStore();
engine.loadOps(await store.getAll());

const channel = new BroadcastChannel(CHANNEL_NAME);

// “离线”= 断开 BroadcastChannel。本地 op 照常写入 IndexedDB 并入队，
// 恢复连接后重新同步（hello 全量对账 + 补发离线期间的 op）。
let online = navigator.onLine;
const pendingOps = [];

channel.onmessage = (event) => handleMessage(event.data);

function handleMessage(msg) {
  if (!msg || msg.tabId === tabId) return; // 忽略自己回环的消息
  if (msg.kind === 'op') {
    if (engine.applyRemote(msg.op)) {
      store.put(msg.op);
      render();
    }
  } else if (msg.kind === 'ops') {
    const added = engine.mergeOps(msg.ops);
    for (const op of msg.ops) store.put(op); // put 幂等（同 key 覆盖）
    if (added > 0) render();
  } else if (msg.kind === 'hello') {
    // 有标签页上线/恢复：全量回发，由对方按 id 去重
    post({ kind: 'ops', tabId, ops: engine.getAllOps() });
  }
}

function post(msg) {
  if (online) channel.postMessage(msg);
}

/** 本地产生一个 op：先落库（防关闭丢失），再广播（或入离线队列） */
async function commit(op) {
  await store.put(op);
  render();
  if (online) {
    channel.postMessage({ kind: 'op', tabId, op });
  } else {
    pendingOps.push(op);
  }
}

function setOnline(next) {
  if (online === next) return;
  online = next;
  if (online) {
    // 恢复连接：补发离线 op + 请求全量对账，双向合并
    for (const op of pendingOps.splice(0)) {
      channel.postMessage({ kind: 'op', tabId, op });
    }
    post({ kind: 'hello', tabId });
  }
  render();
}

// 浏览器网络离线/恢复时自动切换
window.addEventListener('offline', () => setOnline(false));
window.addEventListener('online', () => setOnline(true));

// ---- UI ----

const $ = (id) => document.getElementById(id);
const els = {
  value: $('value'),
  target: $('target'),
  progress: $('progress-fill'),
  inc: $('inc'),
  dec: $('dec'),
  reset: $('reset'),
  targetInput: $('target-input'),
  setTarget: $('set-target'),
  toggle: $('toggle-online'),
  status: $('status'),
  tabId: $('tab-id'),
  opCount: $('op-count'),
};

els.inc.onclick = () => commit(engine.delta(1));
els.dec.onclick = () => commit(engine.delta(-1));
els.reset.onclick = () => commit(engine.reset());
els.setTarget.onclick = () => {
  const v = Number(els.targetInput.value);
  if (Number.isFinite(v)) commit(engine.setTarget(v));
};
els.toggle.onclick = () => setOnline(!online);

function render() {
  const { value, target } = engine.getState();
  els.value.textContent = value;
  if (target === null) {
    els.target.textContent = '目标：未设置';
    els.progress.style.width = '0%';
  } else {
    const pct = target === 0 ? 100 : Math.round((value / target) * 100);
    els.target.textContent = `目标：${target}（${pct}%）`;
    els.progress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  els.status.textContent = online ? '在线' : `离线（待同步 ${pendingOps.length} 条）`;
  els.status.className = online ? 'online' : 'offline';
  els.toggle.textContent = online ? '模拟离线' : '恢复连接';
  els.tabId.textContent = tabId.slice(0, 8);
  els.opCount.textContent = engine.ops.size;
}

// 启动时向其他标签页请求全量对账（覆盖关闭期间错过的消息）
post({ kind: 'hello', tabId });
render();
