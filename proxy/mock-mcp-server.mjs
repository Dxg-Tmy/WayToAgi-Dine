/* MCP 协议模拟服务器（仅用于本地联调，不接真实 Token）
 * 行为对齐麦当劳 MCP（https://mcp.mcd.cn）：
 *   - Streamable HTTP + JSON-RPC 2.0，响应可带 Mcp-Session-Id 头
 *   - initialize → 结果；notifications/initialized → 202 空响应
 *   - tools/call → {content:[{type:'text', text: JSON}]}
 * 用法：node proxy/mock-mcp-server.mjs 9999
 *      MCP_URL=http://127.0.0.1:9999 node proxy/refresh-snapshot.mjs
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 9999);

/* 模拟一份带图片 URL 的菜单（字段名故意用常见变体，验证 normalize 防御映射） */
const MENU = {
  storeCode: 'mock-store-001',
  storeName: '麦当劳（重庆观音桥餐厅 · 模拟）',
  categories: [
    {
      name: '主食',
      items: [
        { code: 'M1001', productCode: 'M1001', name: '巨无霸', price: 2150, picUrl: 'https://picsum.photos/seed/bigmac/400/300', kcal: 550, desc: '双层牛肉，经典之选' },
        { code: 'M1002', productCode: 'M1002', name: '麦辣鸡腿堡', price: 1950, image: 'https://picsum.photos/seed/spicy/400/300', calorie: 490 },
        { code: 'M1003', productCode: 'M1003', name: '板烧鸡腿堡', price: 2050, mealImg: 'https://picsum.photos/seed/grilled/400/300', calories: 430 },
      ],
    },
    {
      name: '小食',
      items: [
        { code: 'M2001', productCode: 'M2001', name: '薯条', price: 950, picture: 'https://picsum.photos/seed/fries/400/300', kcal: 320 },
        { code: 'M2002', productCode: 'M2002', name: '麦乐鸡', price: 1050, smallImage: 'https://picsum.photos/seed/nuggets/400/300', kcal: 380 },
      ],
    },
    {
      name: '饮品',
      items: [
        { code: 'M3001', productCode: 'M3001', name: '可口可乐', price: 800, imagePath: 'https://picsum.photos/seed/cola/400/300', kcal: 180 },
        { code: 'M3002', productCode: 'M3002', name: '热咖啡', price: 900, thumbnail: 'https://picsum.photos/seed/coffee/400/300', kcal: 90 },
      ],
    },
  ],
};

const TOOLS = {
  'now-time-info': () => ({ now: new Date().toISOString(), weekday: 'Saturday' }),
  'query-meals': () => MENU,
  'query-meal-detail': () => ({ code: 'M1001', name: '巨无霸', composition: ['面包', '牛肉饼×2', '生菜', '芝士', '酸黄瓜'] }),
  'calculate-price': () => ({ totalPrice: 3100, originalPrice: 3550, takeWayCode: 'TWC-MOCK-001' }),
  'list-nutrition-foods': () => 'food\tkcal\tprotein\n巨无霸\t550\t26\n麦辣鸡腿堡\t490\t24', // TOON 风格文本
  'query-store-coupons': () => ({ coupons: [{ couponId: 'C001', title: '满 30 减 5', threshold: 3000, reduce: 500 }] }),
  'auto-bind-coupons': () => ({ bound: 2, message: '已领取 2 张券（模拟）' }),
  'create-order': () => ({ orderId: 'MOCK-ORDER-0001', payH5Url: 'https://pay.mcd.cn/mock/0001' }),
  'cancel-order': () => ({ cancelled: true }),
};

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch (_) { res.writeHead(400); res.end('bad json'); return; }

    // initialize：返回会话 ID 头
    if (msg.method === 'initialize') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'mock-session-0001',
      });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcd-mcp', version: '1.0.0' },
        },
      }));
      return;
    }
    // 通知：无响应体
    if (msg.method === 'notifications/initialized' || String(msg.id) === 'undefined') {
      res.writeHead(202); res.end(); return;
    }
    if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      if (!(name in TOOLS)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool: ' + name } }));
        return;
      }
      const data = TOOLS[name]();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock MCP server listening on http://127.0.0.1:${PORT}`);
});
