/* 集成测试：用「网页自身的代码路径」验证真实下单
 *   ① 单品：calculate-price → create-order → cancel-order
 *   ② 套餐：calculate-price（带 roundList，round=round.id）→ create-order → cancel-order
 * 说明：create-order 受「演示账号每日下单限额」约束（错误码 600039）。
 *      额度用尽时，计价类断言照常通过，建单类断言标记为「跳过（额度用尽）」而不是失败。
 * 前置：本地代理在线（双击项目根目录「启动麦点点代理.cmd」）
 * 运行：node web/smoke-realorder.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROXY_BASE || 'http://localhost:8787';
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
  'mock-qr', 'ov-ok', 'ov-cancel', 'net-banner', 'net-banner-msg', 'net-banner-refresh'];
const els = Object.fromEntries(ids.map((i) => [i, makeEl(i)]));
global.document = {
  body: { className: '' },
  getElementById: (id) => els[id] || null,
  addEventListener: () => {},
};
global.window = { speechSynthesis: undefined };
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/')) return realFetch(BASE + u, opts);
  if (u.startsWith('api/')) return realFetch(BASE + '/' + u, opts);
  return realFetch(u, opts);
};

const appCode = fs.readFileSync(path.resolve(__dirname, 'app.js'), 'utf8');
const patched = appCode.replace(/document\.addEventListener\('DOMContentLoaded'.*$/m, '');
const mod = new Function(patched + '\nreturn { App, Store, Catalog, CONFIG };')();
const { App, Store } = mod;

const results = [];
const check = (n, c) => { results.push([n, !!c]); console.log((c ? 'PASS' : 'FAIL') + '  ' + n); };
const skip = (n, why) => { results.push([n, 'skip']); console.log('SKIP  ' + n + '  （' + why + '）'); };

async function mcp(tool, args) {
  const r = await realFetch(BASE + '/api/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: '非 JSON' }));
  if (!j.ok) return { __err: j.error || 'unknown' };
  const env = j.data || {};
  return (env.data !== undefined && env.data !== null) ? env.data : env;
}
const base = { storeCode: '3450379', orderType: 1, beType: 1 };
let quotaHit = false;

try {
  const menu = await (await realFetch(BASE + '/api/menu')).json();
  Store.applyData(Store.normalize(menu));
  Store.mode = 'live';
  check('菜单加载并置为 live 模式', Store.mode === 'live' && Store.items.length > 0);

  // ================= ① 单品 =================
  console.log('\n--- ① 单品路径 ---');
  const single = Store.items.find((i) => i.code && !/套餐|三件套|二件套|随心配|组合/.test(i.name || ''));
  App.order = [{ name: single.name, price: single.price, code: single.code, img: single.img, kind: 'item' }];
  const items1 = App.buildMcpItems();
  check('单品 items 结构正确（productCode + quantity）',
    items1.length === 1 && items1[0].productCode === single.code && items1[0].quantity === 1);
  const p1 = await mcp('calculate-price', { ...base, items: items1 });
  check('单品计价成功（price=' + (p1.price != null ? (p1.price / 100).toFixed(2) + ' 元' : '?') + '）', !p1.__err && p1.price > 0);
  check('计价返回 takeWayList', !!(p1.takeWayList && p1.takeWayList.length));

  // ================= ② 套餐 =================
  console.log('\n--- ② 套餐路径（roundList，round=round.id）---');
  const combo = Store.items.find((i) => i.code && /大堡口福|套餐|三件套/.test(i.name || ''));
  const detail = await mcp('query-meal-detail', { ...base, code: combo.code });
  check('套餐详情可取（' + combo.name + '）', !detail.__err && Array.isArray(detail.rounds) && detail.rounds.length > 0);
  const rounds = detail.rounds || [];
  // 模拟网页选餐结果：每轮取 isDefault 的那项
  const config = rounds.map((rd) => {
    const chs = rd.choices || [];
    const pick = chs.find((c) => c.isDefault) || chs[0];
    return { round: rd.name, roundId: rd.id, choice: pick.name, code: pick.code, diffPrice: pick.diffPrice || '' };
  });
  App.order = [{ name: combo.name, price: combo.price, code: combo.code, img: null, kind: 'combo', config }];
  const items2 = App.buildMcpItems();
  check('套餐 items 带 roundList', items2.length === 1 && Array.isArray(items2[0].roundList) && items2[0].roundList.length === rounds.length);
  check('roundList[].round 是数字 id（传名称会 500）',
    items2[0].roundList.every((r) => typeof r.round === 'number' || /^\d+$/.test(String(r.round))));
  const p2 = await mcp('calculate-price', { ...base, items: items2 });
  check('套餐计价成功（price=' + (p2.price != null ? (p2.price / 100).toFixed(2) + ' 元' : '?') + '）', !p2.__err && p2.price > 0);
  if (p2.__err) console.log('       原始错误：' + p2.__err);

  // ================= ③ 建单 + 取消（受每日额度限制）=================
  console.log('\n--- ③ 真实建单 + 立即取消 ---');
  for (const [tag, items, price] of [['单品', items1, p1], ['套餐', items2, p2]]) {
    if (quotaHit) { skip(tag + ' 真实建单', '今日下单额度已用尽'); continue; }
    if (price.__err) { skip(tag + ' 真实建单', '计价失败'); continue; }
    const tw = (price.takeWayList || [])[0];
    const o = await mcp('create-order', { ...base, takeWayCode: tw.code, items, needTableware: false });
    if (o.__err) {
      if (/600039/.test(o.__err)) { quotaHit = true; skip(tag + ' 真实建单', '今日下单额度已用尽(600039)'); }
      else { check(tag + ' 真实建单：' + o.__err, false); }
      continue;
    }
    const oid = o.orderId || o.orderNo;
    check(tag + ' 真实建单成功（orderId=' + oid + '）', !!oid);
    const c = await mcp('cancel-order', { orderId: oid, cancelReasonCode: '1' });
    const cinner = (c && c.data) ? c.data : c;
    check(tag + ' 订单已取消（无扣款）', !!(cinner && cinner.cancelResult));
  }
} catch (e) {
  check('异常：' + (e && e.message), false);
}

const pass = results.filter((r) => r[1] === true).length;
const skipped = results.filter((r) => r[1] === 'skip').length;
console.log('\n通过 ' + pass + ' / 跳过 ' + skipped + ' / 失败 ' + results.filter((r) => r[1] === false).length + '（共 ' + results.length + '）');
if (results.some((r) => r[1] === false)) process.exitCode = 1;
