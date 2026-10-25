/* 套餐配置 live 路径冒烟：用真实 query-meal-detail 的 rounds 驱动
 * 运行：node web/smoke-combo.mjs   （需本地 proxy 在 8787 且 Token 有效）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeEl(id) {
  const el = {
    id, _text: '', _html: '', hidden: false, className: '', checked: true, width: 220, style: {}, listeners: {}, dataset: {},
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    set onclick(fn) { this._onclick = fn; }, get onclick() { return this._onclick; },
    getContext: () => ({ fillRect() {}, set fillStyle(v) {}, get fillStyle() { return ''; } }),
  };
  return el;
}
const ids = ['topbar', 'mode-badge', 'store-name', 'btn-settings', 'wiz-step', 'wiz-title', 'wiz-hint', 'wiz-list',
  'k-up', 'k-down', 'k-ok', 'overlay', 'overlay-panel', 'settings', 'set-voice', 'set-mock', 'set-physical',
  'btn-hid2', 'btn-log', 'btn-close-settings', 'mcp-log-view', 'toast', 'a11y-live', 'net-banner', 'net-banner-msg',
  'net-banner-refresh', 'mock-qr', 'ov-ok', 'ov-cancel'];
const els = Object.fromEntries(ids.map(i => [i, makeEl(i)]));
global.document = { getElementById: id => els[id] || null, addEventListener: () => {} };
global.window = { speechSynthesis: undefined };

const snapshot = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'data', 'menu-snapshot.json'), 'utf8'));

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('localhost:8787')) return realFetch(url, opts);
  if (String(url).includes('menu-snapshot.json')) return { ok: true, json: async () => snapshot };
  if (String(url).includes('/api/status')) throw new Error('no proxy');
  throw new Error('unexpected fetch: ' + url);
};

const appCode = fs.readFileSync(path.resolve(__dirname, 'app.js'), 'utf8');
const patched = appCode.replace(/document\.addEventListener\('DOMContentLoaded'.*$/, '');
const mod = new Function(patched + '\nreturn { App, Store, Catalog };')();
const { App, Store, Catalog } = mod;

const results = [];
function check(name, cond) { results.push([name, !!cond]); console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); }

async function main() {
  // 0) 从 live 菜单动态取一个套餐：不能写死商品名——门店按时段换菜单，
  //    写死的商品下架后 query-meal-detail 会返回「未匹配到商品(60001)」。
  //    部分早餐套餐在非早餐时段不可下单，这里遍历候选直到找到一个详情能成功返回的套餐。
  const liveMenu = await (await fetch('http://localhost:8787/api/menu')).json();
  const liveItems = (liveMenu.categories || []).flatMap(c => c.items);
  const comboCandidates = liveItems.filter(i => /套餐|三件套|二件套|组合|随心配/.test(i.name || ''));
  if (!comboCandidates.length) throw new Error('live 菜单里没取到套餐类商品');

  let comboItem = null, j = null;
  for (const c of comboCandidates) {
    try {
      const r = await fetch('http://localhost:8787/api/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'query-meal-detail', args: { storeCode: '3450379', orderType: 1, beType: 1, code: c.code } }),
      });
      const resp = await r.json();
      if (resp.ok && resp.data && resp.data.data && Array.isArray(resp.data.data.rounds)) {
        comboItem = c; j = resp; break;
      }
    } catch (e) { /* 试下一个 */ }
  }
  if (!comboItem) throw new Error('没有可配置（query-meal-detail 成功）的套餐');
  console.log('本轮取到的套餐: ' + comboItem.name + ' (code=' + comboItem.code + ' ¥' + (comboItem.price / 100).toFixed(2) + ')');

  // 1) 真实拉一次套餐详情
  const detail = (j.data && j.data.data) ? j.data.data : j.data;
  check('真实详情含 rounds', Array.isArray(detail.rounds) && detail.rounds.length >= 1);
  console.log('  rounds: ' + detail.rounds.map(rd => rd.name + '(' + (rd.choices || []).length + ')').join(' / '));

  // 2) 让 App 走 live 套餐配置
  await App.init();
  Catalog.build();
  Store.mode = 'live';
  Store.data = { store: { code: '3450379', name: '麦当劳重庆解放碑赛博城市餐厅' }, items: Store.items };
  Store.mcp = async () => j.data; // 返回真实 payload

  const combo = Catalog.combos.find(i => i.code === comboItem.code) || comboItem;
  await App.selectCombo(combo);
  check('进入 COMBO_CONFIG', App.state === 'COMBO_CONFIG');
  check('拿到 rounds 而非离线', App.combo && !App.combo.offline && App.combo.detail && App.combo.detail.rounds.length >= 1);

  // 3) 逐轮驱动（每轮最多一次冷热/辣度询问 + 一次选款）
  let guard = 0;
  while (App.state === 'COMBO_CONFIG' && App.combo && !App.combo.offline
    && App.combo.ri < App.combo.detail.rounds.length && guard++ < 30) {
    if (App.options.length > 3) throw new Error('单屏选项超过 3 个: ' + App.options.length);
    if (!App.options.length) throw new Error('轮次没有选项: ri=' + App.combo.ri);
    await App.onOk();
  }
  check('逐轮驱动未超步数', guard < 30);
  const answered = (App.combo.answers || []).filter(Boolean).length;
  check('所有轮次已作答', answered === App.combo.detail.rounds.length);
  check('配置完成标题', App.title === '套餐已配好');
  check('订单已生成且价格 > 0', App.order.length === 1 && App.orderTotal() > 0);
  const has = (kw) => (App.combo.answers || []).some(a => kw.test(a.round));
  check('配置答案覆盖主食/小食/饮料', has(/主食|堡|卷|蛋|鸡/) && has(/小食/) && has(/饮|咖啡/));

  App.onLongOk();
  check('长按确认直接进入支付页', App.state === 'PAY');
  await App.onOk();
  check('支付页确定进入 DONE', App.state === 'DONE');

  const fails = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - fails.length}/${results.length} 通过`);
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error('COMBO SMOKE ERROR:', e.message); process.exit(1); });

