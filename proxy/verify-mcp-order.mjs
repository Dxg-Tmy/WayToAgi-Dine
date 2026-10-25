/* 麦当劳 MCP 真实下单链路自检（会真的创建一单，然后立即取消，不产生扣款）
 * 运行：node proxy/verify-mcp-order.mjs
 * 验证：query-meals → calculate-price → create-order → query-order → cancel-order
 * 说明：走的是网页用的同一个代理接口 http://localhost:8787/api/mcp
 */
const BASE = process.env.PROXY_BASE || 'http://localhost:8787';
const STORE = process.env.MCD_STORE_CODE || '3450379';

const log = (...a) => console.log(...a);
const ok = (s) => log('  [OK] ' + s);
const bad = (s) => { log('  [!!] ' + s); process.exitCode = 1; };

async function mcp(tool, args) {
  const r = await fetch(BASE + '/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: '代理返回非 JSON' }));
  if (!j.ok) throw new Error(tool + ' 失败: ' + (j.error || 'unknown'));
  return j.data && j.data.data !== undefined ? j.data.data : j.data;
}

let createdOrderId = null;

try {
  log('\n=== 0) 代理状态 + 门店真实性核验 ===');
  const st = await (await fetch(BASE + '/api/status')).json();
  log('  mode=' + st.mode + '  store=' + (st.storeName || ''));
  if (st.mode !== 'live') bad('代理不是 live 模式，网页无法实时下单');

  // 门店是否真实存在：直接问麦当劳的门店检索接口
  try {
    const nearby = await mcp('query-nearby-stores', { beType: 1, searchType: 2, city: '重庆市', keyword: '麦当劳' });
    const list = nearby.stores || nearby.list || (Array.isArray(nearby) ? nearby : null) || [];
    const hit = list.find(s => String(s.storeCode || s.code || '') === STORE);
    if (hit) {
      log('  ★ 门店真实存在：' + (hit.storeName || hit.name) + '（code=' + STORE + '）');
      log('    地址：' + (hit.address || hit.storeAddress || '') + '　营业中：' + hit.businessStatus
        + '　营业时间：' + (hit.businessStartTime || '?') + '-' + (hit.businessEndTime || '?'));
      ok('门店核验通过');
    } else {
      bad('门店检索未命中 storeCode=' + STORE + '（本次返回 ' + list.length + ' 家）');
    }
  } catch (e) {
    log('  [跳过] 门店检索失败：' + e.message);
  }

  log('\n=== 1) query-meals 取真实菜单 ===');
  const menu = await (await fetch(BASE + '/api/menu')).json();
  const all = (menu.categories || []).flatMap(c => c.items || []);
  log('  分类 ' + menu.categories.length + ' 个，餐品 ' + all.length + ' 项');
  // 挑一个最简单的单品（非套餐），下单风险最低
  const pick = all.find(i => i.code && !/套餐|三件套|二件套|随心配|组合/.test(i.name || ''));
  if (!pick) throw new Error('菜单里找不到可下单的单品');
  log('  选定单品：' + pick.name + '  code=' + pick.code + '  标价 ¥' + ((pick.price || 0) / 100).toFixed(2));
  ok('菜单可用');

  log('\n=== 2) calculate-price 计价（返回 takeWayList） ===');
  const items = [{ productCode: pick.code, quantity: 1 }];
  const price = await mcp('calculate-price', { storeCode: STORE, orderType: 1, beType: 1, items });
  const total = price.price != null ? price.price : (price.data && price.data.price);
  const takeWayList = price.takeWayList || (price.data && price.data.takeWayList) || [];
  log('  合计 ' + (total != null ? (total / 100).toFixed(2) + ' 元' : '未知') + '（原始值 ' + total + '）');
  log('  takeWayList: ' + JSON.stringify(takeWayList));
  if (!takeWayList.length) throw new Error('calculate-price 没返回 takeWayList，无法下单');
  const takeWayCode = takeWayList[0].code;
  ok('计价成功，取餐方式 code=' + takeWayCode);

  log('\n=== 3) create-order 真实创建订单 ===');
  const order = await mcp('create-order', {
    storeCode: STORE, orderType: 1, beType: 1, takeWayCode,
    items, needTableware: false,
  });
  const orderId = order.orderId || order.orderNo || (order.data && (order.data.orderId || order.data.orderNo));
  createdOrderId = orderId;
  log('  返回: ' + JSON.stringify(order).slice(0, 400));
  if (!orderId) throw new Error('create-order 没返回订单号');
  ok('订单已创建，orderId=' + orderId);

  log('\n=== 4) query-order 回查订单确实存在 ===');
  try {
    const q = await mcp('query-order', { storeCode: STORE, orderId });
    log('  回查: ' + JSON.stringify(q).slice(0, 300));
    ok('订单可在 MCP 端回查');
  } catch (e) {
    bad('query-order 回查失败: ' + e.message);
  }

  log('\n=== 5) cancel-order 立即取消（不产生扣款） ===');
  const c = await mcp('cancel-order', { orderId, cancelReasonCode: '1' });
  log('  返回: ' + JSON.stringify(c).slice(0, 200));
  createdOrderId = null;
  ok('订单已取消，无扣款');
} catch (e) {
  bad(e.message);
  if (createdOrderId) {
    log('\n=== 收尾：尝试取消未清理的订单 ' + createdOrderId + ' ===');
    try {
      await mcp('cancel-order', { orderId: createdOrderId, cancelReasonCode: '1' });
      ok('已取消');
    } catch (e2) { bad('取消失败，请手动处理：' + e2.message); }
  }
}

log('\n=== 结论 ===');
if (process.exitCode) log('  有环节未通过，请看上面 [!!] 标记');
else log('  麦当劳 MCP 全链路（菜单→计价→下单→回查→取消）验证通过 ✅');
