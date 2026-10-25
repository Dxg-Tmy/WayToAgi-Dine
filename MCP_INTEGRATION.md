# MCP_INTEGRATION.md — 麦点点作品的麦当劳 MCP 集成说明

## 1. 使用的 MCP Server

| 项 | 值 |
|---|---|
| 服务名称 | 麦当劳中国 MCP Server（mcd-mcp） |
| 接入地址 | `https://mcp.mcd.cn`（根路径 `/`，Streamable HTTP） |
| 传输协议 | Streamable HTTP（JSON-RPC 2.0），协议版本 2025-06-18 |
| 鉴权方式 | 请求头 `Authorization: Bearer <MCD_MCP_TOKEN>` |
| Token 申请 | open.mcd.cn/mcp 手机号登录 → 控制台 → 激活申请 |
| 限流 | 600 次/分钟（429） |
| 覆盖业务 | 到店取餐点餐、菜单、套餐组成、优惠券、活动日历、营养数据等 |

## 2. Token 安全处理（硬性要求）

- MCP Token 代表麦当劳会员身份，等同于账号凭证，**严禁硬编码、严禁进入公开仓库、严禁出现在录屏/截图**。
- 本地完整模式：Token 只注入 Node 代理进程（`proxy/.env`，已被 `.gitignore` 排除）。浏览器端只与本地代理通信，永远拿不到 Token。
- 开发期快照：通过 WorkBuddy 的 `mcd-mcp` 连接器调用（Token 由 WorkBuddy 连接器托管），调用记录见 `web/data/menu-snapshot.json` 的 `mcpCalls` 字段与本作品开发记录 `workbuddy.md`。
- 本仓库、README、录屏中均不包含真实 Token。

## 3. 实际调用的工具与业务流程

### 3.1 当前向导流程真正调用的（实时链路）

| 步骤 | 工具 | 参数要点 | 用途 |
|---|---|---|---|
| 1 | `query-meals` | `storeCode=3450379, orderType=1, beType=1` | 拉该门店当前在售菜单：13 分类 / 59 项，含 `tags`（爆款/人气/冷饮/热饮…） |
| 2 | `query-meal-detail` | `storeCode, orderType=1, beType=1, code` | **展开套餐真实可选组成**：返回 `rounds`，每轮含 `name` 与 `choices`（`code` / `name` / `diffPrice` / `isDefault` / `supportModify`） |

`query-meal-detail` 是本作品的核心依赖——它让「套餐不是一个固定 SKU」成为可交互的现实。以演示门店
`精选单人餐三件套`（code `9900004064`，¥40）为例，真实返回 3 轮：

| 轮次 | 名称 | 可选项数 | 处理方式 |
|---|---|---|---|
| 1 | 主食任意选 | 1（原味双层深海鳕鱼堡） | **只有 1 项＝固定搭配，自动选定并跳过**，不浪费按键 |
| 2 | 选择套餐内小食 | 5（中薯条/大薯条/小杯玉米杯/大杯玉米杯/脆脆薯条） | 截取高频 3 项（含默认项） |
| 3 | 选择套餐内饮料 | 26（冷/热都有） | **先问「冷饮还是热饮」**，再在所选温度里给 3 项 |

同理，主食轮若同时存在辣与不辣选项，会先问「辣还是不辣」——该判断基于菜名（见 §4 坑 6）。

### 3.2 已开发期验证、当前版本预留的工具

这些能力在早期版本中已真实跑通并留档，当前向导版为保证「不误扣款」默认走模拟支付，故未默认开启：

| 工具 | 验证结论 |
|---|---|
| `now-time-info` | 可取官方时间用于餐段判断（当前版本未接入） |
| `query-nearby-stores` | `beType=1, searchType=2, city=重庆市, keyword=麦当劳` 可定位门店（当前版本用固定演示门店，见下） |
| `list-nutrition-foods` | 返回 CSV 文本（名称,?,kJ,kcal,蛋白质,脂肪,碳水,钠,钙），可按名称匹配取热量；当前版本结构里保留了 `kcal` 字段但未默认接入 |
| `query-store-coupons` + `auto-bind-coupons` | 「麦麦省一键领券」彩蛋，早期版本已跑通；当前版本预留 |
| `calculate-price` | 真实算价 + 取 `takeWayCode`；早期版本 live 跑通 |
| `create-order` / `cancel-order` | **早期版本已 live 端到端跑通并当场取消（无扣款）**；当前向导版默认模拟支付 |

### 3.3 演示门店

| 项 | 值 |
|---|---|
| 门店 | 麦当劳重庆解放碑赛博城市餐厅 |
| storeCode | `3450379`（重庆线上赛区） |
| 配置位置 | `proxy/.env` 的 `MCD_STORE_CODE` / `MCD_STORE_NAME` |

## 4. 已知坑与处理（开发实录，全部实测过）

1. **价格单位不一致（最致命）**：`query-meals` 的 `currentPrice` / `originalPrice` 是**元**（字符串，可能带小数如 `"19.9"`，整数如 `"40"`）；而 `calculate-price` 返回的是**分**。前端统一按「分」存储，所以菜单侧必须 `元 × 100`（`mcp-client.mjs` 的 `toFen`）。早期按分直接存导致 ¥40 显示成 ¥0.40。
2. **菜单结构是两张表**：`query-meals` 的 `data.categories[].meals[]` 只有 `code` + `tags`；名称/图片/价格在 `data.meals{code}` 详情表里。必须合并（`normalizeMenuPayload`），否则前端 `name`/`img` 全是 `undefined`（这正是「菜单空白」事故的根因）。
3. **图片走公开 CDN**：`image` 字段是 `menu-img.mcd.cn` 的真实实物图，浏览器可直接加载、无需鉴权。作品按用户要求展示**实物图**而非抽象图标。
4. **门店编码必须全数字且非空**：`storeCode` 为空会直接报 `storeCode门店编码不能为空`；`.env` 里注释掉 `MCD_STORE_CODE` 就会触发。
5. **`code` vs `productCode`**：`query-meals` 返 `code`，`calculate-price` / `create-order` 要 `productCode`——传错会静默返回 `price: 0`。
6. **辣度与销量 MCP 都不返回**：没有辣度字段、没有销量/排名字段。辣度按菜名推断（麦辣/辣/椒盐）；「最常点的 3 个」＝ `tags` 权重 + `app.js` 中的人工置顶名单（`BEST` / `BEST_COMBOS`）。**不伪造销量数据**。
7. **冷/热饮有 tag 可依**：`饮品` 分类的 `tags` 带 `冷饮` / `热饮`；`麦咖啡` 分类无 tag，按名称（雪冰=冷、咖啡/红茶/黑巧=热）推断。
8. **套餐 choice 用 `code`**：`rounds[].choices[]` 的取值是 `code`（如 `4810` 中薯条），不是分类餐品的 `code`，两者编码空间不同。
9. **端点就是根路径 `/`**：写 `/mcp` 会 404。
10. **响应不是纯 JSON**：MCP 的 text 内容是「字段说明文档 + `## Original Response` + 原始 JSON」，需要先切出 JSON 段再 `JSON.parse`（`parseMcpPayload`）。
11. **业务错误包装在 `success:false` 里**：如 `{success:false, code:400, message:"..."}`，需统一转异常，否则前端拿到空数据。
12. **限流 600 次/分钟**：菜单启动拉一次；服务端 `/api/menu` 15 分钟 TTL 缓存；前端 15 分钟节流 + 手动刷新 30 秒冷却；另有打包快照 / localStorage / `menu.md` 三层离线兜底。
13. 门店打烊错误码 `600057`；`query-nearby-stores` 只传 city 或只传 keyword 报 `600058`。
14. **门店按时段换整套菜单（最易踩）**：同一门店早餐/午餐/晚餐返回完全不同的分类与商品。实测同一 `storeCode=3450379`：
    - 昨晚 20:37 → 13 分类 / 59 项（晚餐：巨无霸/牛鱼肉堡、炸鸡、鸡肉汉堡/卷…）
    - 今晨 09:50 → **9 分类 / 69 项（早餐：满分假日、厚松饼堡系列、麦满分系列、炒双蛋堡系列…）**
    - 因此**绝不能按分类名写死匹配**（早期实现只认「巨无霸/牛鱼肉堡/炸鸡」，早餐一上线主食池直接归零，页面上"主食"整个消失）。现改为「分类名 + 名称关键词 + 兜底」的混合判定，顺序为 **套餐 > 饮料 > 主食(按分类) > 小食 > 兜底主食**；饮料必须排在"主食按分类"之前，否则「满分假日」分类里的奶铁会被误判成主食。
15. **不能写死商品名/code**：跨时段商品会下架，`query-meal-detail` 对已下架商品返回业务错误 `60001 未匹配到商品，请重新拉取全量商品列表`。所以测试与推荐都要从当次 `query-meals` 结果里动态取（`smoke-combo.mjs` 已改为动态取套餐）。

## 5. 真实调用记录

- 每次 `proxy/refresh-snapshot.mjs` 运行都会把调用写入 `web/data/menu-snapshot.json` 的 `mcpCalls` 字段（工具名、时间、成败）。
- 应用内「设置 → MCP 调用记录」面板可实时查看 live 模式的调用流水。
- 早期版本 live 下单链路（`calculate-price` → `create-order` → `cancel-order`）的验证记录见 `workbuddy.md`。
