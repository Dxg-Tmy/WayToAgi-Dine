/* 真实 MCP 探针：把麦当劳 MCP 各工具的原始返回落盘，用于校准字段映射
 * 运行：node proxy/probe-real.mjs
 * 输出：系统临时目录 mcd-probe-*.json（不在仓库内）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpClient, loadEnv } from './mcp-client.mjs';

const env = loadEnv();
const TOKEN = env.MCD_MCP_TOKEN || '';
if (!TOKEN) { console.error('缺少 MCD_MCP_TOKEN'); process.exit(1); }

const client = new McpClient(env.MCP_URL || 'https://mcp.mcd.cn', TOKEN);
const outDir = path.join(os.tmpdir(), 'mcd-probe');
fs.mkdirSync(outDir, { recursive: true });

function dump(name, data) {
  const f = path.join(outDir, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  const size = fs.statSync(f).size;
  console.log(`[${name}] -> ${f} (${(size / 1024).toFixed(1)} KB)`);
  return data;
}

async function probe(tool, args) {
  const t0 = Date.now();
  try {
    const data = await client.callTool(tool, args);
    console.log(`  [OK] ${tool} ${Date.now() - t0}ms`);
    return dump(tool, data);
  } catch (e) {
    console.error(`  [FAIL] ${tool}: ${e.message}`);
    dump(tool, { __error: e.message });
    return null;
  }
}

async function main() {
  console.log('== 1. initialize 握手 ==');
  await client.ensureInit();
  console.log('  sessionId:', client.sessionId || '(无)');

  console.log('== 2. now-time-info ==');
  await probe('now-time-info', {});

  console.log('== 3. query-nearby-stores (重庆) ==');
  const stores = await probe('query-nearby-stores', { beType: 1, searchType: 2, city: '重庆市', keyword: '麦当劳' });

  const list = Array.isArray(stores) ? stores : (stores && (stores.stores || stores.list || stores.data)) || [];
  const first = list[0] || {};
  const storeCode = first.code || first.storeCode || first.storecode || first.id || '';
  const storeName = first.name || first.storeName || first.storename || '';
  console.log(`  门店数: ${list.length}，首个: ${storeName} (${storeCode})`);

  console.log('== 4. query-meals ==');
  await probe('query-meals', { storeCode, orderType: 1, beType: 1 });

  console.log('== 5. query-meal-detail (首个商品) ==');
  const meals = await probe('query-meals', { storeCode, orderType: 1, beType: 1 });
  const cats = (meals && meals.categories) || [];
  const firstItem = (cats[0] && cats[0].items && cats[0].items[0]) || {};
  const itemCode = firstItem.code || firstItem.productCode || '';
  if (itemCode) await probe('query-meal-detail', { productCode: itemCode, code: itemCode });

  console.log('== 6. list-nutrition-foods ==');
  await probe('list-nutrition-foods', {});

  console.log('== 7. query-store-coupons ==');
  await probe('query-store-coupons', { storeCode });

  console.log(`\n探针完成，原始数据在：${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
