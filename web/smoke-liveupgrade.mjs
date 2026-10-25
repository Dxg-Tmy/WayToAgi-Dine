/* 回归测试：复现用户场景：浏览器有"新鲜"localStorage 缓存时，页面能否自动升级到 live 模式
 * （旧实现因 startNetWatch 误用 _idleWatch 标志，后台升级从未启动 → 永远停在 cache/snapshot）
 * 运行：node web/smoke-liveupgrade.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8787';
const realFetch = globalThis.fetch.bind(globalThis);

function makeEl(id) {
  return {
    id, _text: '', _html: '', hidden: false, className: '', checked: true,
    style: {}, listeners: {}, dataset: {}, width: 220,
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    set onclick(fn) { this._onclick = fn; }, get onclick() { return this._onclick; },
    querySelector: () => makeEl('q'), closest: () => null,
    getContext: () => ({ fillRect() {}, set fillStyle(v) {}, get fillStyle() { return ''; } }),
  };
}
const ids = ['topbar', 'mode-badge', 'store-name', 'btn-settings', 'btn-hid2', 'btn-log',
  'btn-close-settings', 'btn-voice-test', 'voice-state', 'debug-state', 'wiz', 'wiz-step', 'wiz-title',
  'wiz-hint', 'wiz-current', 'wiz-list', 'k-up', 'k-down', 'k-ok', 'overlay', 'overlay-panel',
  'settings', 'set-voice', 'set-mock', 'set-physical', 'mcp-log-view', 'toast', 'a11y-live',
  'mock-qr', 'ov-ok', 'ov-cancel', 'net-banner', 'net-banner-msg', 'net-banner-refresh', 'idle-timer', 'btn-home', 'set-idle'];
const els = Object.fromEntries(ids.map((i) => [i, makeEl(i)]));
global.document = { body: { className: '' }, getElementById: (id) => els[id] || null, addEventListener: () => {} };
global.window = { speechSynthesis: undefined };
global.location = { hostname: 'localhost' };

// 模拟"浏览器里有一份刚写入的本地缓存"（15 分钟节流窗口内）
const menuRaw = await (await realFetch(BASE + '/api/menu')).json();
global.localStorage = {
  _d: { data: { items: [{ code: 'x', name: '缓存项', price: 100, tags: [], category: '' }], categories: [] }, ts: Date.now() },
  getItem(k) { return JSON.stringify(this._d); },
  setItem(k, v) { this._d = JSON.parse(v); },
};
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/')) return realFetch(BASE + u, opts);
  if (u.startsWith('api/')) return realFetch(BASE + '/' + u, opts);
  return realFetch(u, opts);
};

const appCode = fs.readFileSync(path.resolve(__dirname, 'app.js'), 'utf8');
const patched = appCode.replace(/document\.addEventListener\('DOMContentLoaded'.*$/m, '');
const mod = new Function(patched + '\nreturn { App, Store, CONFIG };')();
const { App, Store } = mod;

await App.init();
await new Promise((r) => setTimeout(r, 2000));   // 等后台升级完成
console.log('页面启动后 Store.mode =', Store.mode);
console.log('_netWatch 已启动？', !!App._netWatch);
console.log('_idleWatch 已启动？', !!App._idleWatch);
const ok = Store.mode === 'live';
console.log(ok ? '\n✅ 场景修复：即使本地缓存是新鲜的，页面也自动升级到 live → 真实下单可用'
               : '\n❌ 仍停在 ' + Store.mode + '，真实下单会被拒');
process.exit(ok ? 0 : 1);   // 有定时器在跑，必须显式退出
