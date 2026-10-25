/* 麦点点 · 本地代理服务器（零依赖）
 * 作用：
 *   1. 静态托管 web/（评委手机打开 CloudStudio 链接时用的是另一套静态部署，这里是本地 live 模式）
 *   2. 把网页的 MCP 请求转发到 https://mcp.mcd.cn —— Token 只存在于本服务进程，不下发到浏览器
 *
 * 用法：
 *   1) 复制 .env.example 为 .env，填入 MCD_MCP_TOKEN（open.mcd.cn/mcp 申请）
 *   2) node proxy/server.mjs
 *   3) 浏览器打开 http://localhost:8787 （localhost 属于安全上下文，WebHID 可用）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient, loadEnv, normalizeMenuPayload } from './mcp-client.mjs';

const env = loadEnv();
const PORT = Number(env.PORT || 8787);
const TOKEN = env.MCD_MCP_TOKEN || '';
const STORE_CODE = env.MCD_STORE_CODE || '';
const STORE_NAME = env.MCD_STORE_NAME || '';
const CITY = env.MCD_CITY || '重庆市';
const KEYWORD = env.MCD_KEYWORD || '麦当劳';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

let mcp = null;
function getMcp() {
  if (!TOKEN) return null;
  if (!mcp) mcp = new McpClient(env.MCP_URL || 'https://mcp.mcd.cn', TOKEN);
  return mcp;
}

/* 服务端菜单缓存：15 分钟 TTL，避免每次打开页面都打麦当劳 MCP（省额度、防限流） */
const MENU_CACHE_TTL_MS = 15 * 60 * 1000;
let menuCache = { ts: 0, store: null, data: null };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (_) { resolve({}); } });
  });
}

async function handleApi(req, res, url) {
  const client = getMcp();

  if (url.pathname === '/api/status') {
    return sendJson(res, 200, { ok: !!client, mode: client ? 'live' : 'no-token' });
  }

  if (!client) {
    return sendJson(res, 503, { ok: false, error: '未配置 MCD_MCP_TOKEN（在 proxy/.env 中填入）' });
  }

  try {
    if (url.pathname === '/api/menu') {
      const now = Date.now();
      if (menuCache.data && (now - menuCache.ts) < MENU_CACHE_TTL_MS && menuCache.store === STORE_CODE) {
        return sendJson(res, 200, menuCache.data); // 命中服务端缓存，秒回，不再打 MCP
      }
      // 实时菜单 = 当前时段（不合并其它餐段）：保证列出的每一项此刻都真实可下单，避免下单失败。
      // “早中晚全量缓存”由 refresh-snapshot.mjs 生成的静态快照承担（快照模式永不调用 MCP 下单，绝对安全）。
      const meals = await client.callTool('query-meals', { storeCode: STORE_CODE, orderType: 1, beType: 1 });
      const categories = normalizeMenuPayload(meals);
      const payload = {
        generatedAt: new Date().toISOString(),
        source: 'mcd-mcp live (current period)',
        store: { code: STORE_CODE, name: STORE_NAME },
        categories,
      };
      menuCache = { ts: now, store: STORE_CODE, data: payload };
      console.log(`[menu] 当前菜单共 ${categories.length} 个分类 / ${categories.reduce((s, c) => s + c.items.length, 0)} 项餐品`);
      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/mcp' && req.method === 'POST') {
      const { tool, args } = await readBody(req);
      if (!tool) return sendJson(res, 400, { ok: false, error: '缺少 tool' });
      const data = await client.callTool(tool, args || {});
      return sendJson(res, 200, { ok: true, data });
    }

    return sendJson(res, 404, { ok: false, error: 'unknown api' });
  } catch (e) {
    console.error('[api]', url.pathname, e.message);
    return sendJson(res, 502, { ok: false, error: e.message });
  }
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(WEB_ROOT, p));
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`麦点点 live 模式已启动: http://localhost:${PORT}`);
  console.log(TOKEN ? 'MCP Token 已加载（仅存于本进程）' : '警告：未配置 MCD_MCP_TOKEN，将只能以快照模式运行');
  if (!STORE_CODE) console.log(`提示：未配置 MCD_STORE_CODE，query-meals 可能失败；可在 .env 中设置门店编码（${CITY}${KEYWORD}）`);
});
