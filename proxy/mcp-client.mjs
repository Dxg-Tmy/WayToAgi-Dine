/* 麦当劳 MCP Streamable HTTP 客户端（零依赖，Node 18+）
 * 端点：https://mcp.mcd.cn（根路径，勿写 /mcp）
 * 协议：JSON-RPC 2.0 over Streamable HTTP，协议版本 2025-06-18
 * 限流：600 次/分钟；Token 只从环境变量读取，禁止打印
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class McpClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.sessionId = null;
    this.ready = false;
    this._id = 1;
  }

  async _post(body) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (res.status === 202 || !text) return null; // 通知类响应无正文
    if (ct.includes('text/event-stream')) return this._parseSse(text);
    return JSON.parse(text);
  }

  _parseSse(text) {
    let last = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') last = payload;
      }
    }
    return last ? JSON.parse(last) : null;
  }

  _rpc(method, params) {
    return this._post({ jsonrpc: '2.0', id: this._id++, method, params });
  }

  async ensureInit() {
    if (this.ready) return;
    const r = await this._rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'shundian-order-box', version: '1.0.0' },
    });
    if (r && r.error) throw new Error('MCP initialize 失败: ' + JSON.stringify(r.error));
    await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.ready = true;
  }

  async callTool(name, args = {}) {
    await this.ensureInit();
    const r = await this._rpc('tools/call', { name, arguments: args });
    if (r && r.error) throw new Error(`MCP ${name} 调用失败: ` + JSON.stringify(r.error));
    const result = r && r.result;
    const texts = (result && Array.isArray(result.content) ? result.content : [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    const raw = texts.join('\n');
    if (result && result.isError) throw new Error(`MCP ${name} 返回错误: ${raw.slice(0, 200)}`);
    const data = parseMcpPayload(raw);
    // 真实 MCP 用 {success,code,message,data} 表达业务错误，这里统一转成异常
    if (data && typeof data === 'object' && data.success === false) {
      throw new Error(`MCP ${name} 业务错误(${data.code}): ${data.message || ''}`);
    }
    return data;
  }
}

/* 真实 MCP 的 text 内容不是纯 JSON，而是「字段说明文档 + ## Original Response + 原始 JSON」，
 * 这里把原始 JSON 抽出来解析；抽不出就原样返回字符串。 */
export function parseMcpPayload(raw) {
  if (typeof raw !== 'string') return raw;
  const marker = '## Original Response';
  let part = raw;
  const idx = raw.lastIndexOf(marker);
  if (idx >= 0) part = raw.slice(idx + marker.length).trim();
  const s = part.indexOf('{');
  const e = part.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(part.slice(s, e + 1)); } catch (_) { /* 落到下面 */ }
  }
  try { return JSON.parse(raw); } catch (_) { /* 非 JSON，原样返回 */ }
  return raw;
}

/* query-meals 的真实结构：data.categories[].meals[] 只有 code，
 * 名称/图片/价格在 data.meals 详情映射表里，这里合并成前端可直接用的结构。 */
export function normalizeMenuPayload(raw) {
  const root = (raw && raw.data) ? raw.data : (raw || {});
  const detail = (root.meals && typeof root.meals === 'object') ? root.meals : {};
  const cats = [];
  const list = Array.isArray(root.categories) ? root.categories : [];
  for (const c of list) {
    const items = Array.isArray(c.meals) ? c.meals : (Array.isArray(c.items) ? c.items : []);
    const merged = items.map((it) => {
      const d = detail[it.code] || detail[it.productCode] || {};
      const price = d.currentPrice != null ? d.currentPrice : (d.price != null ? d.price : it.price);
      return {
        code: it.code || it.productCode || '',
        productCode: it.productCode || it.code || '',
        name: d.name || it.name || '',
        img: d.image || it.image || '',
        price: toFen(price),
        originalPrice: toFen(d.originalPrice),
        tags: it.tags || d.tags || [],
        desc: d.description || d.desc || '',
        kcal: null,
      };
    });
    if (merged.length) cats.push({ name: c.name || c.categoryName || '餐品', items: merged });
  }
  return cats;
}

/* 金额归一：麦当劳 MCP 返回的 currentPrice / originalPrice 一律是「元」（字符串，可能带小数如 "19.9" 或整数如 "40"），
 * 统一按元→分（×100）转换，供前端 fen2yuan 再除 100 还原。切勿把整数当成已是「分」。 */
export function toFen(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

/* list-nutrition-foods 返回 CSV 文本：名称,?,能量kJ,能量kcal,蛋白质,脂肪,碳水,钠,钙 */
export function parseNutrition(raw) {
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (raw && typeof raw.data === 'string') text = raw.data;
  else if (raw && raw.data) text = JSON.stringify(raw.data);
  const map = new Map();
  for (const line of text.split(/\\n|\n/)) {
    const cols = line.split(',').map((s) => s.trim());
    if (cols.length < 4) continue;
    const name = cols[0];
    if (!name || name === 'null') continue;
    const kcal = Number(cols[3]);
    if (!isFinite(kcal) || kcal <= 0) continue;
    map.set(name, {
      kcal,
      kJ: Number(cols[2]) || 0,
      protein: Number(cols[4]) || 0,
      fat: Number(cols[5]) || 0,
      carbs: Number(cols[6]) || 0,
      sodium: Number(cols[7]) || 0,
      calcium: Number(cols[8]) || 0,
    });
  }
  return map;
}

/* 早 / 午 / 晚 三时段预约时间。
 * 关键约束（已真调验证）：
 *   1) query-meals 的 reservationDate 格式必须是 "yyyy-MM-dd HH:mm"（空格分隔，非 ISO 的 T）
 *   2) 必须是「未来时间」，过去时间会报错 600053
 *   3) 门店按「一天中的时刻」返回菜单：早餐(≈08:00) 与 全天(午/晚/夜) 不同，午晚一致
 * 因此取「明天」对应的时刻，既能满足未来时间，又能拿到该时段的真实菜单。
 * 午餐与晚餐菜单相同，合并时按 code 去重即可，无副作用。
 */
export function buildPeriodReservations() {
  const d = new Date();
  d.setDate(d.getDate() + 1); // 明天，确保是未来时间
  const p = (n) => String(n).padStart(2, '0');
  const at = (h, m) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(h)}:${p(m)}`;
  return [
    { label: '早餐', reservationDate: at(9, 0) },
    { label: '午餐', reservationDate: at(12, 30) },
    { label: '晚餐', reservationDate: at(19, 30) },
  ];
}

/* 把多个时段的归一化分类数组合并为一个：
 *   - 按分类名归并（同名分类合并到一起）
 *   - 类目内按 code 去重（同一商品只保留首次出现，优先保留带图的记录由上层 normalize 已处理）
 * 这样网页一次就能拿到「早 + 午 + 晚」的全量餐品，不会因当前时段只拉到部分菜单而缺选项。 */
export function mergePeriodMenus(periodCategoryArrays) {
  const merged = [];
  const catIndex = new Map();
  const seen = new Set();
  for (const cats of (periodCategoryArrays || [])) {
    if (!Array.isArray(cats)) continue;
    for (const cat of cats) {
      let idx = catIndex.get(cat.name);
      if (idx === undefined) { merged.push({ name: cat.name, items: [] }); idx = merged.length - 1; catIndex.set(cat.name, idx); }
      for (const it of (cat.items || [])) {
        if (!it || !it.code || seen.has(it.code)) continue;
        seen.add(it.code);
        merged[idx].items.push(it);
      }
    }
  }
  return merged;
}

/* 读取 proxy/.env + 进程环境变量（.env 文件不进 Git） */
export function loadEnv() {
  const env = {};
  const file = path.join(__dirname, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...env, ...process.env };
}
