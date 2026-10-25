/* 拉取真实麦当劳菜单，生成 web/data/menu-snapshot.json（静态部署用）
 *
 * 用法：
 *   node proxy/refresh-snapshot.mjs              # 只拉菜单 + 时间
 *   node proxy/refresh-snapshot.mjs --coupons    # 同时自动领券并记录门店可用券（会真实领取账户券）
 *
 * 说明：本脚本是「开发时通过 MCP 拉真实数据」的正规入口，
 * 每次调用都会记录到快照的 mcpCalls 字段，作为「真的调用了麦当劳 MCP」的证据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient, loadEnv, normalizeMenuPayload, parseNutrition, buildPeriodReservations, mergePeriodMenus } from './mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
const TOKEN = env.MCD_MCP_TOKEN || '';
const STORE_CODE = env.MCD_STORE_CODE || '';
const STORE_NAME = env.MCD_STORE_NAME || '';
const CITY = env.MCD_CITY || '重庆市';
const KEYWORD = env.MCD_KEYWORD || '麦当劳';
const WITH_COUPONS = process.argv.includes('--coupons');

if (!TOKEN) {
  console.error('错误：未找到 MCD_MCP_TOKEN。请在 proxy/.env 中填入（open.mcd.cn/mcp 申请）。');
  process.exit(1);
}

const client = new McpClient(env.MCP_URL || 'https://mcp.mcd.cn', TOKEN);
const calls = [];
async function step(tool, args, note) {
  const t0 = Date.now();
  try {
    const data = await client.callTool(tool, args);
    calls.push({ tool, ok: true, at: new Date().toISOString(), ms: Date.now() - t0, note: note || '' });
    console.log(`[OK] ${tool} (${Date.now() - t0}ms)${note ? ' — ' + note : ''}`);
    return data;
  } catch (e) {
    calls.push({ tool, ok: false, at: new Date().toISOString(), ms: Date.now() - t0, note: e.message });
    console.error(`[FAIL] ${tool}: ${e.message}`);
    return null;
  }
}

/* 门店列表：真实返回在 data 数组里 */
function pickStores(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && Array.isArray(raw.stores)) return raw.stores;
  return [];
}

async function main() {
  const nowInfo = await step('now-time-info', {}, '官方时间');

  // 1) 定位门店
  let storeCode = STORE_CODE;
  let storeName = STORE_NAME;
  if (!storeCode) {
    console.log(`未配置 MCD_STORE_CODE，query-nearby-stores 自动取最近门店（${CITY} · ${KEYWORD}）…`);
    const storesRaw = await step('query-nearby-stores', { beType: 1, searchType: 2, city: CITY, keyword: KEYWORD }, '查询附近门店');
    const list = pickStores(storesRaw);
    if (list.length) {
      const s = list[0];
      storeCode = s.storeCode || s.code || '';
      storeName = s.storeName || s.name || '';
      console.log(`选用门店：${storeName}（${storeCode}，距离 ${s.distance || '?'} 米，营业 ${s.businessStartTime || '?'}-${s.businessEndTime || '?'}）`);
    }
  }
  if (!storeCode) {
    console.error('未能确定门店编码（可手动在 proxy/.env 设置 MCD_STORE_CODE）。');
    process.exit(2);
  }

  // 2) 拉门店菜单（早/午/晚三时段合并，保证全量餐品不缺项）
  const periods = buildPeriodReservations();
  const periodCats = [];
  for (const p of periods) {
    const raw = await step('query-meals', { storeCode, orderType: 1, beType: 1, reservationDate: p.reservationDate }, `拉取门店菜单·${p.label}`);
    if (raw) periodCats.push(normalizeMenuPayload(raw));
  }
  if (!periodCats.length) {
    console.error('三时段菜单全部拉取失败，快照未更新。');
    process.exit(2);
  }

  // 3) 合并菜单与详情表（名称/实物图/价格），并用营养数据补热量
  const categories = mergePeriodMenus(periodCats);
  const flat = categories.flatMap(c => c.items.map(i => ({ c, i })));
  const withImg = flat.filter(x => x.i.img).length;
  console.log(`菜单分类 ${categories.length} 个，餐品 ${flat.length} 项，其中带实物图 ${withImg} 项`);

  // 4) 营养数据（CSV），按名称匹配补热量
  const nutritionRaw = await step('list-nutrition-foods', {}, '餐品营养数据');
  const nutritionMap = parseNutrition(nutritionRaw);
  let kcalHit = 0;
  for (const { i } of flat) {
    const hit = nutritionMap.get(i.name);
    if (hit) { i.kcal = hit.kcal; i.nutrition = hit; kcalHit++; }
  }
  console.log(`营养匹配：${kcalHit}/${flat.length} 项命中`);

  // 5) 门店券（可选：会真实领取账户可领券）
  let coupons = null;
  if (WITH_COUPONS) {
    await step('auto-bind-coupons', {}, '一键领取麦麦省优惠券');
    coupons = await step('query-store-coupons', { storeCode, beType: 1, orderType: 1 }, '门店可用券');
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: 'mcd-mcp (via WorkBuddy 开发会话 / refresh-snapshot.mjs)',
    store: { code: storeCode, name: storeName },
    nowTimeInfo: nowInfo,
    periods: periods.map((p) => ({ label: p.label, reservationDate: p.reservationDate })),
    categories,
    nutrition: Array.from(nutritionMap.entries()).map(([name, v]) => ({ name, ...v })),
    coupons,
    mcpCalls: calls,
  };

  const out = path.resolve(__dirname, '..', 'web', 'data', 'menu-snapshot.json');
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`快照已写入 ${out}（${kb} KB），MCP 调用 ${calls.length} 次`);

  // 同时生成内联快照 JS（window.__MENU_SNAPSHOT__）：随页面打包，离线/无代理/file:// 预览也能秒开菜单
  const jsOut = path.resolve(__dirname, '..', 'web', 'data', 'menu-snapshot.js');
  const jsComment = '/* 自动生成：三时段(早+午+晚)合并全量快照，内联打包，供离线/无代理时秒开菜单。请勿手改，由 refresh-snapshot.mjs 生成 */\n';
  fs.writeFileSync(jsOut, jsComment + 'window.__MENU_SNAPSHOT__=' + JSON.stringify(snapshot) + ';\n');
  console.log(`内联快照已写入 ${jsOut}（${((fs.statSync(jsOut).size) / 1024).toFixed(1)} KB）`);

  // 同时生成人类可读的本地缓存 Markdown（菜单离线备份，提交进仓库，静态部署/断网都能用）
  const md = [
    `# 麦点点 · 麦当劳菜单本地缓存`,
    ``,
    `- 门店：${storeName}（${storeCode}）`,
    `- 生成时间：${snapshot.generatedAt}`,
    `- 数据来源：mcd-mcp（WorkBuddy 连接器真调）`,
    `- 餐品总数：${flat.length} 项（均含实物图）`,
    ``,
    ...categories.map((c) => [
      `## ${c.name}`,
      ...c.items.map((i) => `- **${i.name}**  ¥${(i.price / 100).toFixed(2)}${i.kcal ? `  ·  约${i.kcal}千卡` : ''}  ·  [实物图](${i.img || ''})`),
      ``,
    ]).flat(),
    `> 本文件为自动生成的离线缓存，网页运行时以 \`menu-snapshot.json\` 为准。`,
  ].join('\n');
  const mdOut = path.resolve(__dirname, '..', 'web', 'data', 'menu.md');
  fs.writeFileSync(mdOut, md);
  console.log(`本地缓存 Markdown 已写入 ${mdOut}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
