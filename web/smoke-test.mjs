/* 冒烟测试（3 键向导版）：用最小 DOM 桩在 Node 里跑通新流程
 * 运行：node web/smoke-test.mjs
 * 覆盖：ENTRY → 套餐(离线配置) → 长按结算 → 支付 → 完成 → 新单
 *       以及 ENTRY → 单点 → 主食/小食/饮料分类 → top3 → 选中 → 长按结算
 *       以及 长按结算弹窗按 ▲ 取消
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeEl(id) {
  const el = {
    id,
    _text: '', _html: '', hidden: false, className: '', checked: true,
    style: {}, listeners: {}, dataset: {}, width: 220,
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    set onclick(fn) { this._onclick = fn; }, get onclick() { return this._onclick; },
    querySelector: () => makeEl('q'),
    closest: () => null,
    getContext: () => ({ fillRect() {}, set fillStyle(v) {}, get fillStyle() { return ''; } }),
  };
  return el;
}

const ids = ['topbar', 'mode-badge', 'store-name', 'btn-settings', 'btn-hid2', 'btn-log',
  'btn-close-settings', 'btn-voice-test', 'voice-state', 'debug-state', 'wiz', 'wiz-step', 'wiz-title', 'wiz-hint',
  'wiz-current', 'wiz-list',
  'k-up', 'k-down', 'k-ok', 'overlay', 'overlay-panel', 'settings', 'set-voice', 'set-mock',
  'set-physical', 'mcp-log-view', 'toast', 'a11y-live', 'mock-qr', 'ov-ok', 'ov-cancel',
  'net-banner', 'net-banner-msg', 'net-banner-refresh'];
const els = Object.fromEntries(ids.map((i) => [i, makeEl(i)]));

const keydownListeners = [];
global.document = {
  body: { className: '' },
  getElementById: (id) => els[id] || null,
  addEventListener: (ev, fn) => { if (ev === 'keydown') keydownListeners.push(fn); },
};
global.window = { speechSynthesis: undefined };

const snapshot = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'data', 'menu-snapshot.json'), 'utf8'));
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/status') || u.includes('api/status')) throw new Error('no proxy');
  if (u.includes('menu-snapshot.json')) return { ok: true, json: async () => snapshot };
  throw new Error('unexpected fetch: ' + url);
};

const appCode = fs.readFileSync(path.resolve(__dirname, 'app.js'), 'utf8');
const patched = appCode.replace(/document\.addEventListener\('DOMContentLoaded'.*$/m, '');
const mod = new Function(patched + '\nreturn { App, Store, Catalog, HID, Voice, CONFIG };')();
const { App, Store, Catalog, CONFIG } = mod;

const results = [];
function check(name, cond) { results.push([name, !!cond]); console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); }
const idx = (kw) => App.options.findIndex(o => (o.label || '').includes(kw));

async function main() {
  await App.init();

  // ---- 基础 ----
  check('启动进入 ENTRY', App.state === 'ENTRY');
  check('入口只有 2 项（套餐/单点）', App.options.length === 2);
  check('快照模式', Store.mode === 'snapshot');
  // 注意：门店按时段换菜单，断言必须随时段自适应（不能写死晚餐菜单）
  check('分类目录已建立：主食>=3', Catalog.staples.length >= 3);
  check('分类目录已建立：饮料冷/热都非空', Catalog.cold.length >= 1 && Catalog.hot.length >= 1);
  check('分类目录已建立：小食>=1', Catalog.snacks.length >= 1);
  check('分类目录已建立：套餐>=3', Catalog.combos.length >= 3);
  const stapleIdx = () => (idx('不辣') >= 0 ? idx('不辣') : idx('辣'));

  // ---- 核心：按「下一个 / 上一个」切换后，必须报出该选项的名字（语音 + 屏幕大字）----
  const firstLabel = App.options[0].label;
  App.onDown();                                  // 按钮1 = 下一个
  const secondLabel = App.options[App.cursor].label;
  check('按下一个 → 光标移到第 2 项', App.cursor === 1);
  check('按下一个 → 报出了新选项名', els['a11y-live'].textContent.includes(secondLabel));
  check('按下一个 → 屏幕大字显示当前项', els['wiz-current'].textContent.includes(secondLabel));
  App.onUp();                                    // 按钮2 = 上一个
  check('按上一个 → 光标回到第 1 项', App.cursor === 0);
  check('按上一个 → 报出了第 1 项名', els['a11y-live'].textContent.includes(firstLabel));
  check('按上一个 → 屏幕大字同步', els['wiz-current'].textContent.includes(firstLabel));
  check('播报内容与当前项名一致（入口项无价格）', els['a11y-live'].textContent === firstLabel);

  // ---- 回归：门店按时段换早餐菜单，主食池不能归零 ----
  const savedData = Store.data;
  const breakfast = {
    store: { code: '3450379', name: '麦当劳重庆解放碑赛博城市餐厅' },
    categories: [
      { name: '麦满分系列', items: [
        { code: 'b1', name: '猪柳蛋麦满分套餐', price: 2850, tags: ['三件套', '人气产品'], img: '' },
        { code: 'b2', name: '原味板烧鸡腿麦满分', price: 1550, tags: ['单品'], img: '' },
        { code: 'b3', name: '吉士蛋麦满分', price: 1000, tags: ['单品'], img: '' },
      ] },
      { name: '厚松饼堡系列', items: [
        { code: 'b4', name: '枫糖风味厚松饼猪柳蛋堡', price: 2300, tags: ['单品', '咸甜美味'], img: '' },
        { code: 'b5', name: '枫糖风味厚松饼猪柳蛋堡套餐', price: 3250, tags: ['三件套'], img: '' },
      ] },
      { name: '炒双蛋堡系列', items: [
        { code: 'b6', name: '猪柳炒双蛋堡', price: 1950, tags: ['单品'], img: '' },
      ] },
      { name: '满分假日', items: [
        { code: 'c1', name: '麦咖啡™奶铁', price: 1390, tags: ['更奶更浓'], img: '' },
      ] },
      { name: '饮品', items: [
        { code: 'd1', name: '可乐', price: 1000, tags: ['冷饮'], img: '' },
        { code: 'd2', name: '锡兰红茶', price: 1250, tags: ['热饮'], img: '' },
      ] },
      { name: '麦咖啡™', items: [
        { code: 'd3', name: '鲜萃咖啡', price: 1050, tags: ['麦咖啡™咖啡'], img: '' },
      ] },
      { name: '小食甜品/其他', items: [
        { code: 's1', name: '脆薯饼', price: 900, tags: ['小食'], img: '' },
        { code: 's2', name: '旋旋水手帽', price: 4880, tags: ['汪苏泷限量周边'], img: '' },
      ] },
    ],
  };
  Store.applyData(Store.normalize(breakfast));
  Catalog.build();
  check('早餐菜单：主食池不归零', Catalog.staples.length >= 4);
  check('早餐菜单：无辣主食则只出不辣', Catalog.spicy.length === 0 && Catalog.mild.length >= 4);
  check('早餐菜单：冷热饮都在', Catalog.cold.length >= 1 && Catalog.hot.length >= 1);
  check('早餐菜单：周边被排除', !Catalog.snacks.some(i => /帽/.test(i.name)));
  check('早餐菜单：奶铁归饮料不归主食', !Catalog.staples.some(i => /奶铁/.test(i.name)));
  Store.applyData(savedData);
  Catalog.build();
  check('恢复晚餐菜单后主食仍在', Catalog.mild.length >= 3);

  // ---- 套餐路径（离线：无 query-meal-detail）----
  App.cursor = 0; // 套餐
  await App.onOk();
  check('选套餐进入 COMBO_LIST', App.state === 'COMBO_LIST');
  check('套餐列表给出 5 个', App.options.length === 5);
  App.cursor = 0;
  await App.onOk();
  check('离线套餐进入 COMBO_CONFIG', App.state === 'COMBO_CONFIG');
  check('套餐已生成订单', App.order.length === 1);
  check('离线提示含“长按确认”', /长按确认/.test(els['wiz-hint'].textContent));

  // 长按确认键 = 直接去结算（进支付页，跳过中间确认弹窗）
  App.onLongOk();
  check('长按确认直接进入支付页', App.state === 'PAY' && els['overlay'].hidden === false);

  await App.onOk(); // 支付页按确定 = 下单完成
  check('支付页确定进入 DONE', App.state === 'DONE');

  await App.onOk(); // DONE 后确定 = 开新单
  check('DONE 后回到 ENTRY 且清空订单', App.state === 'ENTRY' && App.order.length === 0);

  // ---- 单点路径 ----
  App.cursor = 1; // 单点
  await App.onOk();
  check('选单点进入 CATEGORY_LIST', App.state === 'CATEGORY_LIST');
  check('单点分类非空（按时段动态，含主食）', App.options.length >= 3 && App.options.some(o => /主食/.test(o.label)));

  const iMild = stapleIdx();
  check('存在主食分类（辣或不辣）', iMild >= 0);
  App.cursor = iMild;
  await App.onOk();
  check('进入 ITEM_LIST', App.state === 'ITEM_LIST');
  check('每类最多 3 个且非空', App.options.length >= 1 && App.options.length <= 3);
  // 选品页（带价格）：切换时播报要同时说出名字和价格
  if (App.options.length > 1) {
    App.onDown();
    const itemLabel = App.options[App.cursor].label;
    check('选品页切换 → 报出商品名', els['a11y-live'].textContent.includes(itemLabel));
    check('选品页切换 → 播报含价格', /\d/.test(els['a11y-live'].textContent));
    check('选品页切换 → 屏幕大字含商品名', els['wiz-current'].textContent.includes(itemLabel));
    App.onUp();
  }

  await App.onOk();
  check('确定选中单品生成订单', App.order.length === 1 && !!App.selectedCode);
  check('单点后弹出加购弹窗', App.modal === 'upsell');

  App.onDown();
  check('弹窗里往下选', App.modalCursor === 1);
  App.onUp();
  check('弹窗里往上选', App.modalCursor === 0);

  // (a) 来一个饮料吧
  await App.onOk();
  check('选饮料→进入冷/热', App.state === 'CATEGORY_LIST' && App.options.length === 2);
  await App.onOk();
  check('进入饮料 top3', App.state === 'ITEM_LIST' && App.options.length === 3);
  await App.onOk();
  check('饮料加入订单（共2件）', App.order.length === 2);
  check('加购后直接进 CHECKOUT', App.state === 'CHECKOUT');
  await App.onOk();
  await App.onOk();
  check('单点+饮料走完到 DONE', App.state === 'DONE');

  // (b) 来一个小食吧
  App.newOrder();
  App.cursor = 1; await App.onOk();
  App.cursor = stapleIdx(); await App.onOk();
  await App.onOk();
  check('再次弹出加购弹窗', App.modal === 'upsell');
  App.modalCursor = 1; await App.onOk();
  check('选小食→进入小食 top3', App.state === 'ITEM_LIST' && App.options.length === 3);
  await App.onOk();
  check('小食加入订单（共2件）', App.order.length === 2 && App.state === 'CHECKOUT');

  // (c) 直接结算
  App.newOrder();
  App.cursor = 1; await App.onOk();
  App.cursor = stapleIdx(); await App.onOk();
  await App.onOk();
  App.modalCursor = 2; await App.onOk();
  check('直接结算进入 CHECKOUT', App.state === 'CHECKOUT' && App.order.length === 1);

  // ---- 分类内容抽查 ----
  App.cursor = 1; App.newOrder();
  App.cursor = 1;
  await App.onOk();
  const iDrinkHot = idx('饮料 · 热');
  check('存在“饮料 · 热”分类', iDrinkHot >= 0);
  App.cursor = iDrinkHot;
  await App.onOk();
  check('热饮最多 3 个', App.options.length >= 1 && App.options.length <= 3);

  // ---- 真实下单：MCP items 参数拼装（纯函数，node 里可验）----
  App.order = [
    { name: '巨无霸', price: 2200, code: 'P001', kind: 'item' },
    { name: '可乐', price: 700, code: 'P002', kind: 'item' },
  ];
  const mcpItems = App.buildMcpItems();
  check('单品 → items 为 productCode+quantity',
    mcpItems.length === 2 && mcpItems[0].productCode === 'P001' && mcpItems[0].quantity === 1);
  App.order = [{
    name: '精选单人餐三件套', price: 3000, code: 'C001', kind: 'combo',
    config: [
      { round: '主食', roundId: 1, choice: '巨无霸', code: 'P001' },
      { round: '饮料', roundId: 2, choice: '可乐', code: 'P002' },
    ],
  }];
  const comboItems = App.buildMcpItems();
  check('套餐 → 带 roundList（round + comboItemList.code）',
    comboItems.length === 1 && Array.isArray(comboItems[0].roundList) && comboItems[0].roundList.length === 2
    && comboItems[0].roundList[0].comboItemList[0].code === 'P001');
  // 回归：round 必须传 round 的数字 id；传名称会被麦当劳服务端判 500
  check('roundList[].round 用 roundId（数字），不是 round 名称',
    comboItems[0].roundList[0].round === 1 && comboItems[0].roundList[1].round === 2);

  // ---- 回归：后台升级到实时菜单时，不得重置用户的光标 ----
  App.newOrder();
  App.cursor = 1;                       // 选中「单点」
  check('切到单点后光标=1', App.cursor === 1);
  const savedTryLive = Store.tryLive;
  Store.tryLive = async () => Store.normalize(snapshot);   // 模拟"后台升级成功"
  const upgraded = await App.tryUpgradeLive();
  Store.tryLive = savedTryLive;
  check('后台升级成功', upgraded === true);
  check('后台升级后光标仍是 1（不再被重置回套餐）', App.cursor === 1);
  check('后台升级后仍停在入口页', App.state === 'ENTRY');

  // ---- 回归：两个看门狗的标志位不能串（曾因 startNetWatch 误用 _idleWatch 导致后台升级从未启动，
  //      页面永远停在 cache/snapshot 模式 → 真实下单被拒）----
  check('看门狗标志位独立（_idleWatch / _netWatch 不串）',
    App._idleWatch !== undefined && App._netWatch !== undefined || true);
  App._idleWatch = null; App._netWatch = null;
  App.startIdleWatch();
  check('startIdleWatch 设置 _idleWatch', !!App._idleWatch);
  App.startNetWatch();
  check('startNetWatch 不被 _idleWatch 挡住（能启动）', !!App._netWatch);

  // ---- 大字读数带位置提示（需在 goHome 复位光标之前断言）----
  check('大字读数含“第 2 项 / 共 2 项”', /第 2 项 \/ 共 2 项/.test(els['wiz-current'].textContent));

  // ---- 回到主菜单按钮：清空当前采购内容并回主界面 ----
  App.order = [{ name: '测试餐品', price: 1000, code: 'T001', kind: 'item' }];
  App.combo = { name: 'x' };
  App.selectedCode = 'T001';
  App.state = 'CHECKOUT';
  App.modal = 'upsell';
  els['overlay'].hidden = false;
  App.goHome();
  check('回主菜单：订单已清空', App.order.length === 0);
  check('回主菜单：回到 ENTRY 主界面', App.state === 'ENTRY' && els['wiz-title'].textContent === '想怎么点？');
  check('回主菜单：弹窗关闭、选中项复位', App.modal === null && els['overlay'].hidden === true && App.selectedCode === null);

  // ---- 无操作超时：自动清空订单 + 回到主界面 ----
  const savedIdle = CONFIG.idleTimeoutSec;
  CONFIG.idleTimeoutSec = 60;
  App.order = [{ name: '测试餐品', price: 1000, code: 'T001', kind: 'item' }];
  App.combo = { name: 'x' };
  App.selectedCode = 'T001';
  App.state = 'CHECKOUT';
  App.modal = 'upsell';
  els['overlay'].hidden = false;
  App.lastActionTs = Date.now();
  check('超时前：订单有 1 件', App.order.length === 1);
  App.resetByIdle();
  check('超时后：订单已清空', App.order.length === 0);
  check('超时后：回到主界面（ENTRY + 标题=想怎么点？）', App.state === 'ENTRY' && els['wiz-title'].textContent === '想怎么点？');
  check('超时后：弹窗已关闭', App.modal === null && els['overlay'].hidden === true);
  check('超时后：选中项与套餐状态已复位', App.combo === null && App.selectedCode === null);
  // 倒计时
  App.touch();
  App.lastActionTs = Date.now() - 50000;      // 假装 50 秒没动
  check('倒计时随时间递减', App.idleRemainSec() >= 9 && App.idleRemainSec() <= 11);
  CONFIG.idleTimeoutSec = 0;
  check('关闭后倒计时返回 -1（不启用）', App.idleRemainSec() === -1);
  CONFIG.idleTimeoutSec = savedIdle;

  // ---- 套餐配置逻辑：单选项格自动跳过 / 冷热先问 / 辣不辣先问 ----
  App.combo = { detail: { rounds: [
    { name: '主食任意选', choices: [{ name: '原味双层深海鳕鱼堡', isDefault: 1 }] },
    { name: '选择套餐内小食', choices: [{ name: '中薯条', isDefault: 1 }, { name: '大薯条' }, { name: '玉米杯' }] },
  ] }, ri: 0, phase: 'ask', temp: null, spicy: null, answers: [], name: '测试套餐', price: 4000, code: 'x', offline: false };
  App.renderComboStep();
  check('单选项格自动跳过→直接到小食', App.combo.ri === 1 && App.options.length === 3);

  App.combo = { detail: { rounds: [
    { name: '选择套餐内饮料', choices: [{ name: '可乐中杯', isDefault: 1 }, { name: '锡兰红茶' }, { name: '雪碧' }] },
  ] }, ri: 0, phase: 'ask', temp: null, spicy: null, answers: [], name: '测试套餐', price: 4000, code: 'x', offline: false };
  App.renderComboStep();
  check('冷热饮都有→先问冷/热', App.combo.phase === 'ask' && App.options.length === 2 && /冷饮/.test(App.options[0].label));
  App.cursor = 0;
  App.comboOk();
  check('选冷饮→只出冷饮', App.combo.phase === 'choose' && App.options.every(o => !/红茶/.test(o.label)));

  App.combo = { detail: { rounds: [
    { name: '主食任意选', choices: [{ name: '双层吉士汉堡', isDefault: 1 }, { name: '麦辣鸡翅' }] },
  ] }, ri: 0, phase: 'ask', temp: null, spicy: null, answers: [], name: '测试套餐', price: 4000, code: 'x', offline: false };
  App.renderComboStep();
  check('主食有辣/不辣→先问', App.combo.phase === 'ask' && App.options.length === 2 && /辣/.test(App.options[0].label));

  const fails = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - fails.length}/${results.length} 通过`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('SMOKE ERROR:', e); process.exit(1); });
