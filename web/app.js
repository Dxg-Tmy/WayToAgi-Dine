'use strict';
/* ============================================================
 * 麦点点 · 无障碍顺序点餐（3 键向导版）
 * ------------------------------------------------------------
 * 3 个按键（与实体点餐盒一一对应）：
 *   按钮1 = 下一个（往下选，循环）／ 按钮2 = 上一个（往上选，循环）／ 按钮3 = 确认
 *   按钮3 长按（≥0.8s）= 直接去结算（进支付页）；实体键同样映射，见下方 WebHID 段
 * 选品原则：每屏最多 3 个高频选项，套餐最多 5 个。
 * 数据：本地代理真实调用麦当劳 MCP（Token 只在服务端）。
 * ============================================================ */

const CONFIG = {
  snapshotUrl: 'data/menu-snapshot.json',
  statusUrl: 'api/status',
  menuUrl: 'api/menu',
  probeTimeoutMs: 1500,
  mockPayment: true,
  refreshIntervalMs: 15 * 60 * 1000,
  manualCooldownMs: 30 * 1000,
  longPressMs: 800,
  idleTimeoutSec: 60,   // 无操作多少秒后自动清空订单并回到主界面（0 = 关闭）
  idleWarnSec: 10,      // 剩余多少秒时语音提醒
};

const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el && el.addEventListener) el.addEventListener(ev, fn); return el; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const fen2yuan = (fen) => '¥' + (Number(fen || 0) / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
const fen2speech = (fen) => {
  const yuan = Number(fen || 0) / 100;
  const int = Math.floor(yuan);
  const dec = Math.round((yuan - int) * 10);
  if (dec === 0) return `${int}块`;
  if (dec === 5) return `${int}块5`;
  return `${int}块${dec}`;
};

/* 辣度：MCP 无此字段，按菜名推断；如与门店实际不符，改这一个函数即可 */
function isSpicy(name) { return /辣|椒盐|麻辣|香辣|酸辣/.test(name || ''); }

/* 饮品冷热：优先用 tags（饮品分类自带「冷饮/热饮」），无 tag 时按名称推断 */
function isHotDrink(item) {
  const tags = (item && item.tags || []).join('');
  if (/热饮/.test(tags)) return true;
  if (/冷饮/.test(tags)) return false;
  const n = (item && item.name) || '';
  if (/雪冰|冰爽|冰沙|冰咖啡/.test(n)) return false;
  if (/咖啡|红茶|黑巧|卡布奇诺|美式|奶铁|浓缩|牛奶|燕麦奶|热/.test(n)) return true;
  return false;
}

/* ---------------- 语音播报 ----------------
 * 三个关键修复（此前"切换选项没有报出名字"的根因）：
 *  1) Chrome 在 cancel() 之后同一 tick 立即 speak() 会把这条语音直接丢弃（连按越快越哑）。
 *     → 改为 cancel 后延迟一帧再 speak，并做"最新优先"合并（快速连按时只播最后一条）。
 *  2) 原来异常被 catch 静默吞掉，出问题也看不到 → 现在记录 lastError 并 console 提示。
 *  3) 无论 TTS 是否可用，文字都同步落到无障碍 live 区域与屏幕大字（可见兜底）。
 */
const Voice = {
  on: true,
  voice: null,
  lastError: '',
  spokenCount: 0,
  _timer: null,
  _primed: false,

  init() {
    if (typeof window === 'undefined') return;
    if (!('speechSynthesis' in window) || !window.speechSynthesis) return;
    const pick = () => {
      try {
        const vs = window.speechSynthesis.getVoices() || [];
        if (!vs.length) return;
        const zh = vs.filter((v) => /zh|cmn|Chinese/i.test(v.lang || ''));
        const prefer = zh.find((v) => /女|婷|妍|美|悦|雅|Xiaoxiao|Yun|Yaoyao|Hui|Hao|Ting|Yue|Mei|Lan|Female/i.test(v.name || ''))
          || zh.find((v) => /Female/i.test(v.name || ''))
          || zh[0]
          || vs[0];
        if (prefer) this.voice = prefer;
      } catch (e) { /* 忽略 */ }
    };
    pick();
    // 语音列表是异步加载的：注册变更回调 + 轮询兜底
    try { window.speechSynthesis.onvoiceschanged = () => pick(); } catch (e) { /* 忽略 */ }
    let tries = 0;
    const retry = setInterval(() => { pick(); if (this.voice || ++tries > 20) clearInterval(retry); }, 300);
    // Chrome 长时间会话后语音会自动暂停，定时 resume 兜底（否则会突然没声音）
    setInterval(() => {
      try { if (window.speechSynthesis && window.speechSynthesis.paused) window.speechSynthesis.resume(); } catch (e) { /* 忽略 */ }
    }, 5000);
  },

  /* 首次用户手势时预热语音引擎，避免第一句被浏览器拦下不发声 */
  prime() {
    if (this._primed || typeof window === 'undefined') return;
    if (!('speechSynthesis' in window) || !window.speechSynthesis) return;
    this._primed = true;
    try {
      window.speechSynthesis.resume();
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; u.rate = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  },

  speak(text, { rate = 0.95, pitch = 1.0 } = {}) {
    if (!text) return;
    // 1) 文字兜底：无论 TTS 是否可用，播报内容一定落地
    const live = $('a11y-live');
    if (live) live.textContent = text;
    if (!this.on) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !window.speechSynthesis) {
      this.lastError = '当前浏览器不支持语音合成';
      return;
    }
    // 2) 真正发声：cancel 后延迟一帧再 speak，规避 Chrome 丢音竞态
    try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = rate;
        u.pitch = pitch;
        if (this.voice) u.voice = this.voice;
        u.onerror = (ev) => { this.lastError = '语音错误：' + (ev && ev.error ? ev.error : 'unknown'); };
        window.speechSynthesis.speak(u);
        this.spokenCount++;
        this.lastError = '';
      } catch (e) {
        this.lastError = '语音失败：' + (e && e.message ? e.message : String(e));
        console.warn('[语音] 播报失败：', e);
      }
    }, 90);
  },

  /* 供「设置」面板显示当前语音状态，方便现场排查"到底有没有在发音" */
  diagnose() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !window.speechSynthesis) {
      return '语音合成不可用（本浏览器不支持）';
    }
    const v = this.voice ? (this.voice.name + ' / ' + this.voice.lang) : '未找到中文语音（将用系统默认音色）';
    const st = window.speechSynthesis.speaking ? '正在播报' : '空闲';
    return v + ' · ' + st + ' · 累计播报 ' + this.spokenCount + ' 条' + (this.lastError ? ' · ' + this.lastError : '');
  },
};

/* ---------------- 按键提示音（Web Audio 咔嚓声） ----------------
 * 硬件已去掉蜂鸣器，提示音由网页用 Web Audio 现场合成，无需任何资源文件。
 * 在用户手势（按键/点击）内首次触发时会自动 resume，符合浏览器自动播放策略。 */
const Click = {
  ctx: null,
  ensure() {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
    }
    if (this.ctx && this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) { /* 忽略 */ } }
  },
  play(kind = 'tick') {
    try { this._play(kind); } catch (e) { /* 提示音失败绝不影响点餐主流程 */ }
  },
  _play(kind = 'tick') {
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    if (kind === 'ok') {
      o.frequency.setValueAtTime(740, t);
      o.frequency.exponentialRampToValueAtTime(1480, t + 0.06);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      o.stop(t + 0.14);
    } else {
      o.frequency.setValueAtTime(1500, t);
      o.frequency.exponentialRampToValueAtTime(760, t + 0.03);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.stop(t + 0.09);
    }
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t);
  },
};

/* ---------------- 付款完成庆祝 / 奖励效果 ---------------- */
const Celebrate = {
  burst() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function' || !document.body) return;
    // 彩带（纯 CSS 动画，装饰性，aria-hidden）
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    layer.setAttribute('aria-hidden', 'true');
    const colors = ['#c8102e', '#ffbc0d', '#1f7a3f', '#1a5fd0', '#ff7a00', '#e84a8a', '#16b1a7'];
    const N = 90;
    for (let i = 0; i < N; i++) {
      const s = document.createElement('span');
      s.className = 'confetti-piece';
      const size = 6 + Math.random() * 9;
      s.style.left = (Math.random() * 100) + 'vw';
      s.style.top = '-20px';
      s.style.width = size + 'px';
      s.style.height = (size * 0.5) + 'px';
      s.style.background = colors[i % colors.length];
      s.style.animationDelay = (Math.random() * 0.6) + 's';
      s.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
      s.style.transform = `rotate(${Math.random() * 360}deg)`;
      layer.appendChild(s);
    }
    document.body.appendChild(layer);
    setTimeout(() => { try { layer.remove(); } catch (e) { /* 忽略 */ } }, 4400);

    // 轻快上行提示音（C5-E5-G5-C6）
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => {
        const t = ctx.currentTime + i * 0.12;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.32);
      });
      setTimeout(() => { try { ctx.close(); } catch (e) { /* 忽略 */ } }, 1300);
    } catch (e) { /* 忽略 */ }
  },
};

/* ---------------- MCP 调用记录 ---------------- */
const McpLog = {
  entries: [],
  add(tool, ok, detail) {
    this.entries.push({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), tool, ok: !!ok, detail: detail || '' });
    this.render();
  },
  render() {
    const box = $('mcp-log-view');
    if (!box) return;
    box.textContent = this.entries.length
      ? this.entries.map(e => `[${e.t}] ${e.tool} ${e.ok ? 'OK' : 'FAIL'} ${e.detail}`).join('\n')
      : '（暂无调用记录）';
  },
};

let toastTimer = 0;
function toast(msg, ms = 2800) {
  const el = $('toast');
  if (el) {
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  Voice.speak(msg);
}

/* ---------------- 数据层 ---------------- */
const Store = {
  mode: null, // 'live' | 'cache' | 'snapshot'
  data: null,
  items: [],
  lastRefreshTs: 0,
  networkWarning: false,

  readLocalCache() {
    try {
      const raw = localStorage.getItem('shundian_menu_cache_v1');
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.data || !Array.isArray(obj.data.items) || !obj.data.items.length) return null;
      return obj;
    } catch (e) { return null; }
  },
  writeLocalCache(data) {
    try { localStorage.setItem('shundian_menu_cache_v1', JSON.stringify({ data, ts: Date.now() })); } catch (e) { /* 忽略 */ }
  },
  applyData(data) { this.data = data; this.items = data.items || []; },

  async trySnapshot() {
    try {
      const r = await fetch(CONFIG.snapshotUrl, { cache: 'force-cache' });
      if (!r.ok) return null;
      const d = this.normalize(await r.json());
      return d && d.items.length ? d : null;
    } catch (e) { return null; }
  },

  async tryLive() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.probeTimeoutMs);
    try {
      const r = await fetch(CONFIG.statusUrl, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || !j.ok) return null;
      const rm = await fetch(CONFIG.menuUrl, { cache: 'no-store' });
      if (!rm.ok) return null;
      const d = this.normalize(await rm.json());
      if (d && d.items.length) { McpLog.add('query-meals', true, ''); return d; }
      return null;
    } catch (e) { return null; }
  },

  async load({ force = false, onUpgrade } = {}) {
    let local = this.readLocalCache();
    let base = null, baseMode = null;
    if (local) { base = local.data; baseMode = 'cache'; this.lastRefreshTs = local.ts || 0; }
    // 内置快照（页面打包的 data/menu-snapshot.js → window.__MENU_SNAPSHOT__）：即使完全无网络/无代理/file:// 预览也能秒开全量菜单
    if (!base && typeof window !== 'undefined' && window.__MENU_SNAPSHOT__) {
      const snap = this.normalize(window.__MENU_SNAPSHOT__);
      if (snap && snap.items.length) { base = snap; baseMode = 'snapshot'; this.lastRefreshTs = 0; }
    }
    if (!base) {
      const snap = await this.trySnapshot();
      if (snap) { base = snap; baseMode = 'snapshot'; this.lastRefreshTs = 0; }
    }
    if (base) { this.applyData(base); this.mode = baseMode; }

    const stale = force || !this.lastRefreshTs || (Date.now() - this.lastRefreshTs) > CONFIG.refreshIntervalMs;
    if (stale && (this.mode !== 'live' || force)) {
      try {
        const live = await this.tryLive();
        if (live) {
          this.applyData(live);
          this.mode = 'live';
          this.lastRefreshTs = Date.now();
          this.writeLocalCache(live);
          if (onUpgrade) onUpgrade();
        }
      } catch (e) { /* 静默 */ }
    }
    this.networkWarning = (this.mode !== 'live');
    return this.mode;
  },

  normalize(raw) {
    const cats = Array.isArray(raw.categories) ? raw.categories : [];
    const items = [];
    for (const c of cats) {
      const list = Array.isArray(c.items) ? c.items : [];
      for (const it of list) {
        items.push({
          code: it.code || it.mealCode || it.productCode || it.id || '',
          productCode: it.productCode || it.code || it.mealCode || '',
          name: it.name || it.mealName || it.title || '未命名餐品',
          price: Number(it.price != null ? it.price : (it.currentPrice != null ? it.currentPrice : (it.salePrice != null ? it.salePrice : it.originalPrice))) || 0,
          kcal: Number(it.kcal || it.calorie || it.calories) || null,
          img: it.img || it.imageUrl || it.image || it.picture || it.picUrl || it.pic || it.goodsImg || it.mealImg || it.smallImage || it.imagePath || it.thumbnail || '',
          desc: it.desc || it.description || '',
          tags: Array.isArray(it.tags) ? it.tags : [],
          category: c.name || it.category || '',
        });
      }
    }
    return {
      store: raw.store || {},
      categories: cats.map(c => ({ name: c.name || '餐品', count: (c.items || []).length })),
      items,
      mcpCalls: Array.isArray(raw.mcpCalls) ? raw.mcpCalls : [],
      generatedAt: raw.generatedAt || '',
    };
  },

  async mcp(tool, args = {}) {
    if (this.mode !== 'live') throw new Error('当前为快照模式，无法实时调用');
    const r = await fetch('api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args }),
    });
    const j = await r.json().catch(() => ({ ok: false, error: '代理返回异常' }));
    McpLog.add(tool, j.ok, j.ok ? '' : (j.error || ''));
    if (!j.ok) throw new Error(j.error || 'MCP 调用失败');
    return j.data;
  },
};

/* ---------------- 选品目录（从真实菜单派生） ----------------
 * 注意：MCP 不返回销量，这里用「人工置顶名单 + 爆款/人气标签」排序，
 * 名单可随时改，改完立即生效（不依赖任何外部接口）。
 */
const BEST = {
  '主食·辣': ['麦辣鸡翅', '那么大鸡排'],
  '主食·不辣': ['双层吉士汉堡', '麦香鱼', '双层深海鳕鱼堡'],
  '小食': ['薯条', '玉米杯', '派'],
  '饮料·冷': ['可乐', '雪碧', '多汁柠柠'],
  '饮料·热': ['锡兰红茶', '鲜萃咖啡', '浓浓黑巧'],
};
const BEST_COMBOS = ['精选单人餐三件套', '大堡口福三件套', '麦乐鸡套餐', '学生专享汉堡小食随心选', '人气经典随心配'];

const Catalog = {
  staples: [], spicy: [], mild: [], snacks: [], cold: [], hot: [], combos: [],

  build() {
    const seen = new Set();
    const all = (Store.items || []).filter((it) => {
      if (!it.code || seen.has(it.code)) return false;
      seen.add(it.code);
      return true;
    });
    const nm = (it) => (it.name || '').replace(/\n/g, '');
    const cat = (it) => (it.category || '').replace(/\n/g, '');
    const tagStr = (it) => (it.tags || []).join('/');

    /* 非餐品（周边/玩具） */
    const isSideProp = (it) => /周边|帽|玩偶|玩具|徽章|水手帽/.test(nm(it)) || /周边|限量/.test(tagStr(it));
    /* 套餐 / 组合 */
    const isBundled = (it) => /套餐|三件套|四件套|二件套|组合|随心配|随心选|百宝袋|拼盘/.test(nm(it))
      || ['套餐', '小食拼盘', '经典精选', '大口吃肉好快乐', '超值百种组合随心配', '麦金卡', '三件套', '二件套'].some(t => tagStr(it).includes(t));

    /* 饮料：分类名 + 名称关键词 */
    const isDrinkName = (n) => /可乐|雪碧|红茶|咖啡|豆浆|牛奶|果汁|柠柠|橙橙|纯悦|怡泉|黑巧|奶铁|美式|卡布奇诺|浓缩|奶绿|可可|雪冰|燕麦奶|热奶|冰牛奶|奶茶/.test(n);
    const DRINK_CAT = /饮|咖啡|一早现磨|奶茶/;
    /* 小食：分类名 + 名称关键词 */
    const isSnackName = (n) => /薯条|薯饼|鸡块|鸡翅|鸡排|派|玉米|油条|沙拉|洋葱圈|小食|豆浆组合|甜筒|冰淇淋|蛋挞/.test(n);
    const SNACK_CAT = /小食|甜品|拼盘/;
    /* 主食：分类名（覆盖早中晚各时段，避免写死单一菜单） */
    const STAPLE_CAT = /堡|卷|饭|粥|巨无霸|牛鱼肉|炸鸡|鸡肉|麦满分|厚松饼|炒双蛋|主食|汉堡/;

    /* 判定顺序：套餐 > 饮料 > 主食(按分类) > 小食 > 兜底主食
     * 关键：不能只匹配「巨无霸/牛鱼肉堡/炸鸡」这类晚餐分类名——门店按时段换菜单，
     * 早餐是「麦满分系列/厚松饼堡系列/炒双蛋堡系列」，硬编码会让主食池整体归零。
     * 饮料必须排在“主食按分类”之前，否则「满分假日」分类里的奶铁会被误判成主食。 */
    const combos = all.filter(it => !isSideProp(it) && isBundled(it));
    const single = all.filter(it => !isSideProp(it) && !isBundled(it));
    const kindOf = (it) => {
      const c = cat(it), n = nm(it);
      if (DRINK_CAT.test(c) || isDrinkName(n)) return 'drink';
      if (STAPLE_CAT.test(c)) return 'staple';
      if (SNACK_CAT.test(c) || isSnackName(n)) return 'snack';
      return 'staple'; // 未知分类默认主食，保证入口不会空
    };
    const drinks = single.filter(it => kindOf(it) === 'drink');
    const snacks = single.filter(it => kindOf(it) === 'snack');
    const staples = single.filter(it => kindOf(it) === 'staple');

    this.staples = staples;
    this.spicy = staples.filter(it => isSpicy(it.name));
    this.mild = staples.filter(it => !isSpicy(it.name));
    this.snacks = snacks;
    this.cold = drinks.filter(it => !isHotDrink(it));
    this.hot = drinks.filter(it => isHotDrink(it));
    this.combos = combos;
  },

  score(it) {
    const t = it.tags || [];
    let s = 0;
    if (t.includes('爆款')) s += 3;
    if (t.includes('人气')) s += 2;
    if (t.includes('超值') || t.includes('立省10.5元起')) s += 1.5;
    if (t.includes('麦金卡') || t.includes('学生')) s += 1;
    return s;
  },

  topN(list, n, best) {
    const out = [];
    for (const nm of (best || [])) {
      const f = list.find(it => it.name.includes(nm) || nm.includes(it.name));
      if (f && !out.some(o => o.code === f.code)) out.push(f);
    }
    const rest = list.filter(it => !out.some(o => o.code === it.code))
      .sort((a, b) => this.score(b) - this.score(a));
    for (const it of rest) {
      if (out.length >= n) break;
      out.push(it);
    }
    return out.slice(0, n);
  },

  topCombos(n) { return this.topN(this.combos, n, BEST_COMBOS); },
};

/* ---------------- WebHID 点餐盒 ----------------
 * 实体键映射（与硬件固件码一致）：按钮1(0x01)=下一个 按钮2(0x02)=上一个 按钮3(0x03)=确认 按钮3长按(0x04)=直接结算
 * 屏幕 / 键盘端已内置长按（按钮3 长按 = 直接结算）。
 */
const HID = {
  device: null,
  supported: () => ('hid' in navigator),
  async connect() {
    if (!this.supported()) { toast('当前浏览器不支持 WebHID，请用桌面 Chrome/Edge；已用屏幕按钮'); return false; }
    try {
      const [dev] = await navigator.hid.requestDevice({ filters: [{ usagePage: 0xff00 }] });
      if (!dev) return false;
      return await this.open(dev);
    } catch (e) { return false; }
  },
  async autoReconnect() {
    if (!this.supported()) return false;
    try {
      const devs = await navigator.hid.getDevices();
      const box = devs.find(d => (d.collections || []).some(c => c.usagePage === 0xff00)) || devs[0];
      if (box) return await this.open(box);
    } catch (e) { /* 忽略 */ }
    return false;
  },
  async open(dev) {
    try {
      if (!dev.opened) await dev.open();
      this.device = dev;
      dev.addEventListener('inputreport', (e) => {
        // 兼容两种固件布局（实测常见为「无 Report ID，帧 [0x01, code]」）：
        //   布局A（带 Report ID=1）：e.reportId===1，e.data 仅 1 字节（载荷）→ getUint8(0)
        //   布局B（无 Report ID）：e.reportId===0，硬件帧为 2 字节 [0x01, code] → getUint8(1)
        const bytes = Array.from({ length: e.data.byteLength }, (_, i) => e.data.getUint8(i));
        let code;
        if (e.reportId === 1) {
          code = bytes[0];
          if ((code < 1 || code > 4) && bytes.length >= 2) code = bytes[1]; // 兜底：固件把 ID 也当数据发了
        } else {
          code = bytes.length >= 2 ? bytes[1] : bytes[0];
        }
        console.log('[点餐盒] inputreport reportId=' + e.reportId + ' bytes=' + bytes.map(b => ('0' + b.toString(16)).slice(-2)).join(' '));
        // 记录最近一次按键，供「设置」面板实时显示，方便现场判断"事件到了没"
        if (typeof App !== 'undefined') { App.lastHid = { code: code, bytes: bytes, ts: Date.now() }; App.showDebugState(); }
        switch (code) {
          case 0x01: App.onDown(); break;        // 按钮1 = 下一个（往下选，循环）
          case 0x02: App.onUp(); break;          // 按钮2 = 上一个（往上选，循环）
          case 0x03: App.onOk(); break;          // 按钮3 短按 = 确认
          case 0x04: App.onLongOk(); break;      // 按钮3 长按 = 直接结算（进支付页）
          default: break;
        }
      });
      Voice.speak('点餐盒连上啦，可以开始点餐咯。');
      this.feedback(2);
      return true;
    } catch (e) { toast('点餐盒打开失败：' + (e && e.message ? e.message : '未知错误')); return false; }
  },
  feedback(action) {
    if (!this.device) return;
    try { this.device.sendReport(0x02, new Uint8Array([action])); } catch (e) { /* 忽略 */ }
  },
};

/* 模拟支付二维码（确定性图案，明确标注演示） */
function drawMockQr(canvas) {
  const ctx = canvas.getContext('2d');
  const N = 21, cell = Math.floor(canvas.width / N);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  let seed = 20241024;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  ctx.fillStyle = '#191919';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (rnd() > 0.52) ctx.fillRect(x * cell, y * cell, cell, cell);
  const finder = (cx, cy) => {
    ctx.fillStyle = '#191919'; ctx.fillRect(cx * cell, cy * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#ffffff'; ctx.fillRect((cx + 1) * cell, (cy + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#191919'; ctx.fillRect((cx + 2) * cell, (cy + 2) * cell, 3 * cell, 3 * cell);
  };
  finder(0, 0); finder(N - 7, 0); finder(0, N - 7);
}

/* ---------------- 应用状态机 ---------------- */
const App = {
  state: 'BOOT', // BOOT|ENTRY|COMBO_LIST|COMBO_CONFIG|CATEGORY_LIST|ITEM_LIST|CHECKOUT|PAY|DONE
  cursor: 0,
  options: [],
  order: [],
  combo: null,
  modal: null,
  lastHid: null, // 最近一次收到的实体按键（现场调试用）
  lastActionTs: 0, // 最后一次操作时间戳（无操作超时用）
  _idleWarned: false,
  modalCursor: 0,
  selectedCode: null,
  adding: false,
  lastOrder: null,
  stepLabel: '',
  title: '',
  hint: '',

  async init() {
    this.bindEvents();
    Voice.init();
    try { await Store.load({ onUpgrade: () => this.renderMode() }); } catch (e) { /* 已降级 */ }
    if (!Store.mode) {
      // 极罕见：连内置快照都未能加载（通常是快照脚本被拦截）。此时不弹吓人的“网络异常”，而是温和提示刷新
      this.title = '菜单暂未就绪';
      this.hint = '请稍候或点右上角「设置」刷新页面重试。';
      this.options = [];
      this.render();
      this.showNetBanner('info', '菜单暂未就绪，请刷新页面重试');
      Voice.speak('菜单还没准备好，请刷新一下页面再试。');
      return;
    }
    Catalog.build();
    // 有可用的本地/离线菜单时不弹红色「网络异常」：纯静态部署（snapshot）本就是常态、不弹横幅；
    // 仅当“本地缓存/离线快照”时给中性提示，并说明实时下单需要本地代理在运行。
    if (Store.networkWarning && Store.mode === 'cache') {
      this.showNetBanner('info', '当前显示本地缓存菜单；实时菜单与真实下单需要本地代理在运行（双击「启动麦点点代理.cmd」），代理恢复后会自动切换');
    } else if (Store.networkWarning && Store.mode === 'snapshot' && this.isLocalhost()) {
      this.showNetBanner('warn', '本地代理未运行：实时菜单与真实下单不可用。请双击「启动麦点点代理.cmd」后点「刷新菜单」');
    }
    this.renderMode();
    this.enterEntry();
    this.touch();
    this.startIdleWatch();
    Voice.speak('您好，欢迎来麦点点点餐。您是想点点套餐，还是自己单点呀？');
    HID.autoReconnect();
    this.startNetWatch();
  },

  bindEvents() {
    on('k-up', 'click', () => this.onUp());
    on('k-down', 'click', () => this.onDown());

    const okEl = $('k-ok');
    if (okEl && okEl.addEventListener) {
      let timer = null, isLong = false;
      const start = () => { isLong = false; clearTimeout(timer); timer = setTimeout(() => { isLong = true; this.onLongOk(); }, CONFIG.longPressMs); };
      const end = () => { clearTimeout(timer); if (!isLong) this.onOk(); };
      okEl.addEventListener('pointerdown', start);
      okEl.addEventListener('pointerup', end);
      okEl.addEventListener('pointerleave', () => clearTimeout(timer));
    }

    on('wiz-list', 'click', (e) => {
      const li = e && e.target && e.target.closest ? e.target.closest('.opt') : null;
      if (li) { this.cursor = Number(li.dataset.i) || 0; this.onOk(); }
    });

    on('overlay-panel', 'click', (e) => {
      if (this.modal !== 'upsell') return;
      const d = e && e.target && e.target.closest ? e.target.closest('.upsell-opt') : null;
      if (d) { this.modalCursor = Number(d.dataset.m) || 0; this.upsellOk(); }
    });

    on('btn-home', 'click', () => { this.goHome(); toast('已清空当前订单，回到主菜单'); });
    on('btn-settings', 'click', () => { const d = $('settings'); if (d) d.hidden = false; this.showVoiceState(); this.showDebugState(); });
    on('btn-close-settings', 'click', () => { const d = $('settings'); if (d) d.hidden = true; });
    on('btn-voice-test', 'click', () => {
      Voice.prime();
      Voice.speak('语音播报正常，我是麦点点点餐助手，现在选中的是' + (this.options[this.cursor] ? this.options[this.cursor].label : '第一项'));
      setTimeout(() => this.showVoiceState(), 700);
    });
    on('btn-hid2', 'click', () => HID.connect());
    on('btn-log', 'click', () => { const v = $('mcp-log-view'); if (v) v.hidden = !v.hidden; });
    on('net-banner-refresh', 'click', () => this.refreshMenu());
    on('set-voice', 'change', (e) => { Voice.on = e.target.checked; if (Voice.on) Voice.speak('语音播报已开启'); });
    on('set-mock', 'change', (e) => { CONFIG.mockPayment = e.target.checked; toast(e.target.checked ? '已切换为模拟支付' : '已切换为真实下单'); });
    on('set-physical', 'change', (e) => {
      if (document.body) document.body.className = e.target.checked ? 'physical' : '';
      toast(e.target.checked ? '已切换为实体点餐盒' : '已切换为屏幕按钮');
    });
    on('set-idle', 'change', (e) => {
      CONFIG.idleTimeoutSec = Number(e.target.value) || 0;
      this.touch();
      toast(CONFIG.idleTimeoutSec ? ('无操作 ' + CONFIG.idleTimeoutSec + ' 秒后自动清空订单') : '已关闭自动清空');
    });

    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); this.onUp(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.onDown(); }
      else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); this.onLongOk(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onOk(); }
    });

    // 首次用户手势时预热语音引擎（部分浏览器要求先有交互才允许发声）
    if (typeof window !== 'undefined' && window.addEventListener) {
      const primeOnce = () => {
        Voice.prime();
        window.removeEventListener('pointerdown', primeOnce);
        window.removeEventListener('keydown', primeOnce);
      };
      window.addEventListener('pointerdown', primeOnce);
      window.addEventListener('keydown', primeOnce);
    }
  },

  /* 在「设置」里显示当前语音引擎状态，方便现场判断"到底有没有在发音" */
  showVoiceState() {
    const el = $('voice-state');
    if (!el) return;
    el.textContent = '语音状态：' + Voice.diagnose();
  },

  /* 现场调试面板：页面 / 光标 / 选中项 / 最近一次实体按键 —— 一眼看清"事件到了没、光标动没动" */
  showDebugState() {
    const el = $('debug-state');
    if (!el) return;
    const o = this.options[this.cursor];
    const hid = this.lastHid
      ? ('0x' + ('0' + this.lastHid.code.toString(16)).slice(-2) + '（' + (this.lastHid.bytes || []).map(b => ('0' + b.toString(16)).slice(-2)).join(' ') + '）')
      : '尚未收到';
    const names = { 0x01: '下一个', 0x02: '上一个', 0x03: '确认', 0x04: '长按=结算' };
    el.textContent = '运行状态：页面=' + (this.state || '-')
      + '　光标=' + (this.cursor + 1) + '/' + this.options.length
      + '　选中=' + (o ? o.label : '-')
      + '　订单=' + this.order.length + '件'
      + '　最近按键=' + hid + (this.lastHid ? '（' + (names[this.lastHid.code] || '未知') + '）' : '');
  },

  /* ---------- 无操作超时：自动清空订单并回到主界面 ----------
   * 场景：用户拿了餐盒离开/走神，屏幕不能一直停在一半的订单上。
   * 行为：倒计时归零 → 清空订单与弹窗 → 回到「想怎么点？」入口页 → 语音告知。 */
  touch() {
    this.lastActionTs = Date.now();
    this._idleWarned = false;
    this.renderIdleTimer();
  },

  idleRemainSec() {
    const total = Number(CONFIG.idleTimeoutSec) || 0;
    if (!total) return -1;
    return Math.max(0, total - Math.floor((Date.now() - (this.lastActionTs || Date.now())) / 1000));
  },

  renderIdleTimer() {
    const el = $('idle-timer');
    if (!el) return;
    const left = this.idleRemainSec();
    if (left < 0) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = left + ' 秒后自动清空';
    el.className = 'idle-timer' + (left <= 10 ? ' idle-timer--urgent' : '');
  },

  startIdleWatch() {
    if (typeof window === 'undefined' || this._idleWatch) return;
    if (!this.lastActionTs) this.lastActionTs = Date.now();
    this._idleWatch = setInterval(() => {
      this.renderIdleTimer();
      const left = this.idleRemainSec();
      if (left < 0) return;
      // 下单进行中不打断
      if (this._submitting || this.state === 'PAY') return;
      if (left === CONFIG.idleWarnSec && !this._idleWarned) {
        this._idleWarned = true;
        Voice.speak(`还有 ${left} 秒没有操作，订单会自动清空。`);
      }
      if (left === 0) this.resetByIdle();
    }, 1000);
  },

  /* 超时重置：清空一切，回到主界面 */
  resetByIdle() {
    const had = this.order.length > 0;
    this.order = [];
    this.combo = null;
    this.selectedCode = null;
    this.lastOrder = null;
    this.modal = null;
    this.adding = false;
    const ov = $('overlay'); if (ov) ov.hidden = true;
    this.enterEntry();
    this.touch();
    Voice.speak(had
      ? '长时间没有操作，订单已经清空了。咱们重新开始，想点套餐还是单点？'
      : '长时间没有操作，已回到首页。咱们重新开始，想点套餐还是单点？');
  },

  /* 判断当前是否跑在本机（localhost/127.0.0.1）——本机跑就意味着代理应该存在，
   * 拿不到实时菜单通常说明代理没启动，可以给出明确提示而不是含糊的“网络异常”。 */
  isLocalhost() {
    if (typeof location === 'undefined' || !location.hostname) return false;
    return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(location.hostname);
  },

  /* 一键回到主菜单：清空当前采购内容（订单/套餐/选中项/弹窗）并回到「想怎么点？」入口页 */
  goHome(say) {
    const had = this.order.length > 0;
    this.order = [];
    this.combo = null;
    this.selectedCode = null;
    this.lastOrder = null;
    this.modal = null;
    this.adding = false;
    const ov = $('overlay'); if (ov) ov.hidden = true;
    this.enterEntry();
    this.touch();
    Voice.speak(say || (had
      ? '已清空当前订单，回到首页。想点套餐还是单点？'
      : '已回到首页。想点套餐还是单点？'));
  },

  /* ---------- 按键 ---------- */
  onUp() {
    this.touch();
    Click.play('tick');
    if (this.modal === 'upsell') {
      this.modalCursor = (this.modalCursor + 2) % 3;
      this.renderUpsellModal();
      return;
    }
    if (this.modal) { this.cancelModal(); return; }
    if (!this.options.length) return;
    this.cursor = (this.cursor - 1 + this.options.length) % this.options.length;
    this.render();
    this.speakCurrent();
  },
  onDown() {
    this.touch();
    Click.play('tick');
    if (this.modal === 'upsell') {
      this.modalCursor = (this.modalCursor + 1) % 3;
      this.renderUpsellModal();
      return;
    }
    if (this.modal) { this.cancelModal(); return; }
    if (!this.options.length) return;
    this.cursor = (this.cursor + 1) % this.options.length;
    this.render();
    this.speakCurrent();
  },
  async onOk() {
    this.touch();
    Click.play('ok');
    if (this.modal === 'upsell') { this.upsellOk(); return; }
    switch (this.state) {
      case 'ENTRY': this.options[this.cursor].data === 'combo' ? this.enterComboList() : this.enterCategoryList(); return;
      case 'COMBO_LIST': await this.selectCombo(this.options[this.cursor].data); return;
      case 'CATEGORY_LIST': this.enterItemList(this.options[this.cursor].data); return;
      case 'ITEM_LIST': this.pickItem(this.options[this.cursor].data); return;
      case 'COMBO_CONFIG': this.comboOk(); return;
      case 'CHECKOUT': this.enterPay(); return;
      case 'PAY': await this.submitOrder(); return;
      case 'DONE': this.newOrder(); return;
    }
  },
  onLongOk() {
    this.touch();
    Click.play('ok');
    if (!this.order.length) { toast('还没选东西，先选一份吧'); return; }
    this.enterPay(); // 长按确认键 = 直接去结算（进支付页）
  },

  /* ---------- 页面 ---------- */
  enterEntry() {
    this.state = 'ENTRY';
    this.modal = null;
    const ov = $('overlay'); if (ov) ov.hidden = true;
    this.stepLabel = '第 1 步 / 共 3 步';
    this.title = '想怎么点？';
    this.hint = '▲▼选择，按确认进入。选好后长按确认可直接去结算。';
    this.options = [
      { label: '套餐', sub: '推荐，最快；主食/小食/饮料一次配好', data: 'combo' },
      { label: '单点', sub: '自己挑主食、小食或饮料', data: 'single' },
    ];
    this.cursor = 0;
    this.render();
  },

  enterComboList() {
    const list = Catalog.topCombos(5);
    if (!list.length) { toast('这家店暂时没有套餐'); return; }
    this.state = 'COMBO_LIST';
    this.stepLabel = '第 2 步 / 共 3 步';
    this.title = '选一个套餐';
    this.hint = '▲▼选择。选中后进入套餐配置。';
    this.options = list.map(it => ({ label: it.name, sub: '套餐', price: it.price, img: it.img, data: it }));
    this.cursor = 0;
    this.render();
    this.speakCurrent(true);
  },

  enterCategoryList() {
    const cats = [];
    if (Catalog.spicy.length) cats.push({ key: '主食·辣', label: '主食 · 辣', sub: '辣味主食', items: Catalog.spicy });
    if (Catalog.mild.length) cats.push({ key: '主食·不辣', label: '主食 · 不辣', sub: '不辣主食', items: Catalog.mild });
    if (Catalog.snacks.length) cats.push({ key: '小食', label: '小食', sub: '薯条 / 玉米 / 派', items: Catalog.snacks });
    if (Catalog.cold.length) cats.push({ key: '饮料·冷', label: '饮料 · 冷', sub: '可乐 / 雪碧 / 柠柠', items: Catalog.cold });
    if (Catalog.hot.length) cats.push({ key: '饮料·热', label: '饮料 · 热', sub: '红茶 / 咖啡 / 黑巧', items: Catalog.hot });
    this.state = 'CATEGORY_LIST';
    this.stepLabel = '第 2 步 / 共 3 步';
    this.title = '点哪一类？';
    this.hint = '主食先分辣/不辣；饮料先分冷/热。';
    this.options = cats.map(c => ({ label: c.label, sub: c.sub, data: c }));
    this.cursor = 0;
    this.render();
    this.speakCurrent(true);
  },

  enterItemList(cat) {
    const list = Catalog.topN(cat.items, 3, BEST[cat.key]);
    this.state = 'ITEM_LIST';
    this.stepLabel = '第 3 步 / 共 3 步';
    this.title = cat.label;
    this.hint = '只给你最常点的 3 个。▲▼选择，确认选中。';
    this.options = list.map(it => ({ label: it.name, sub: it.category, price: it.price, img: it.img, data: it }));
    this.cursor = 0;
    this.selectedCode = null;
    this.render();
    this.speakCurrent(true);
  },

  pickItem(it) {
    const line = { name: it.name, price: it.price, code: it.code, img: it.img, kind: 'item' };
    if (this.adding) {
      this.order.push(line);
      this.adding = false;
      this.selectedCode = it.code;
      this.enterCheckout();
      return;
    }
    this.order = [line];
    this.selectedCode = it.code;
    this.hint = `已选：${it.name}，${fen2yuan(it.price)}。`;
    this.render();
    Voice.speak(`好嘞，给您选了${it.name}，${fen2speech(it.price)}。要不要再添点小食或者饮料呢？`);
    this.modal = 'upsell';
    this.modalCursor = 0;
    this.renderUpsellModal();
  },

  /* 单点后追问：饮料 / 小食 / 直接结算 */
  renderUpsellModal() {
    const ov = $('overlay'), panel = $('overlay-panel');
    if (!ov || !panel) return;
    ov.hidden = false;
    panel.className = 'panel';
    const opts = [
      { label: '来一个饮料吧', sub: '冷饮或热饮' },
      { label: '来一个小食吧', sub: '薯条 / 玉米 / 派' },
      { label: '直接结算', sub: '我都不要' },
    ];
    panel.innerHTML = `
      <h2>还要加点吗？</h2>
      <div class="upsell-list">
        ${opts.map((o, i) => `
          <div class="upsell-opt${i === this.modalCursor ? ' active' : ''}" data-m="${i}">
            <span class="opt-label">${esc(o.label)}</span>
            <span class="opt-sub">${esc(o.sub)}</span>
          </div>`).join('')}
      </div>
      <div class="tip">▲▼选择，按确认。长按确认直接结算。</div>`;
  },

  upsellOk() {
    const keys = ['drink', 'snack', 'checkout'];
    const key = keys[this.modalCursor] || 'checkout';
    this.modal = null;
    const ov = $('overlay'); if (ov) ov.hidden = true;
    if (key === 'drink') this.enterDrinkChoice();
    else if (key === 'snack') this.enterSnackList();
    else this.enterCheckout();
  },

  enterDrinkChoice() {
    this.adding = true;
    this.state = 'CATEGORY_LIST';
    this.stepLabel = '加点饮料';
    this.title = '要冷饮还是热饮？';
    this.hint = '▲▼选择，确认后看具体款。';
    this.options = [
      { label: '饮料 · 冷', sub: '可乐 / 雪碧 / 柠柠', data: { key: '饮料·冷', label: '饮料 · 冷', items: Catalog.cold } },
      { label: '饮料 · 热', sub: '红茶 / 咖啡 / 黑巧', data: { key: '饮料·热', label: '饮料 · 热', items: Catalog.hot } },
    ];
    this.cursor = 0;
    this.render();
    this.speakCurrent(true);
  },

  enterSnackList() {
    this.adding = true;
    this.enterItemList({ key: '小食', label: '小食', items: Catalog.snacks });
    this.stepLabel = '加点小食';
    this.hint = '只给你 3 个。▲▼选择，确认选中。';
    this.render();
  },

  /* ---------- 套餐配置 ---------- */
  async selectCombo(it) {
    this.order = [{ name: it.name, price: it.price, code: it.code, img: it.img, kind: 'combo' }];
    this.combo = { detail: null, ri: 0, phase: 'ask', temp: null, spicy: null, answers: [], name: it.name, price: it.price, code: it.code, offline: false };

    if (Store.mode !== 'live') { this.combo.offline = true; this.renderComboOffline(); return; }

    try {
      const d = await Store.mcp('query-meal-detail', { storeCode: Store.data.store.code, orderType: 1, beType: 1, code: it.code });
      const detail = (d && d.data) ? d.data : d;
      if (detail && Array.isArray(detail.rounds) && detail.rounds.length) {
        this.combo.detail = detail;
        this.combo.ri = 0;
        this.combo.phase = 'ask';
        this.state = 'COMBO_CONFIG';
        this.stepLabel = '第 3 步 / 共 3 步';
        this.renderComboStep();
        return;
      }
    } catch (e) { /* 落到离线 */ }
    this.combo.offline = true;
    this.renderComboOffline();
  },

  renderComboOffline() {
    this.state = 'COMBO_CONFIG';
    this.stepLabel = '第 3 步 / 共 3 步';
    this.title = this.combo.name;
    this.hint = '离线模式：按默认搭配。长按确认去结算。';
    this.options = [{ label: this.combo.name, sub: '默认搭配', price: this.combo.price, data: null }];
    this.cursor = 0;
    this.render();
  },

  renderComboStep() {
    const c = this.combo;
    if (!c || !c.detail) { this.renderComboDone(); return; }
    const rounds = c.detail.rounds || [];
    // 只有 1 个可选项的格子＝固定搭配，自动选定并跳过，减少按键
    while (c.ri < rounds.length) {
      const rd = rounds[c.ri];
      const chs = rd.choices || [];
      if (chs.length === 1) {
        c.answers[c.ri] = { round: rd.name, roundId: rd.id, choice: chs[0].name, code: chs[0].code || '', diffPrice: chs[0].diffPrice || '' };
        c.ri++; c.phase = 'ask'; c.temp = null; c.spicy = null;
        continue;
      }
      break;
    }
    if (c.ri >= rounds.length) { this.renderComboDone(); return; }
    const round = rounds[c.ri];
    const choices = (round.choices || []).slice().sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    const isStaple = /主食|堡|卷/.test(round.name || '');
    const isDrink = /饮/.test(round.name || '') || choices.some(ch => /可乐|雪碧|红茶|咖啡|柠柠|橙橙|牛奶|纯悦/.test(ch.name || ''));
    const hasSpicy = choices.some(ch => isSpicy(ch.name));
    const hasMild = choices.some(ch => !isSpicy(ch.name));
    const hasHot = choices.some(ch => isHotDrink({ name: ch.name }));
    const hasCold = choices.some(ch => !isHotDrink({ name: ch.name }));

    this.state = 'COMBO_CONFIG';
    this.stepLabel = '第 3 步 / 共 3 步';

    if (c.phase === 'ask') {
      if (isStaple && hasSpicy && hasMild && !c.spicy) {
        this.title = round.name + '：辣还是不辣？';
        this.hint = '▲▼选择，确认后看具体款。';
        this.options = [{ label: '辣', sub: '辣味主食', data: 'spicy' }, { label: '不辣', sub: '不辣主食', data: 'mild' }];
        this.cursor = 0;
        this.render();
        return;
      }
      if (isDrink && hasHot && hasCold && !c.temp) {
        this.title = round.name + '：冷饮还是热饮？';
        this.hint = '▲▼选择，确认后看具体款。';
        this.options = [{ label: '冷饮', sub: '冰的', data: 'cold' }, { label: '热饮', sub: '热的', data: 'hot' }];
        this.cursor = 0;
        this.render();
        return;
      }
      c.phase = 'choose';
    }

    let list = choices;
    if (c.spicy) list = list.filter(ch => c.spicy === 'spicy' ? isSpicy(ch.name) : !isSpicy(ch.name));
    if (c.temp) list = list.filter(ch => c.temp === 'hot' ? isHotDrink({ name: ch.name }) : !isHotDrink({ name: ch.name }));
    if (!list.length) list = choices;
    list = list.slice(0, 3);

    this.title = round.name;
    this.hint = '只给你 3 个。▲▼选择，确认定下这一格。';
    this.options = list.map(ch => ({
      label: ch.name,
      sub: (ch.diffPrice && ch.diffPrice !== '+ ¥0') ? ch.diffPrice : '',
      data: { ...ch, roundName: round.name },
    }));
    this.cursor = 0;
    this.render();
    this.speakCurrent(true);
  },

  comboOk() {
    const c = this.combo;
    if (!c || c.offline || !c.detail) return;
    const rounds = c.detail.rounds;
    if (c.ri >= rounds.length) return;
    const round = rounds[c.ri];

    if (c.phase === 'ask') {
      const sel = this.options[this.cursor].data;
      if (sel === 'spicy' || sel === 'mild') c.spicy = sel;
      else if (sel === 'hot' || sel === 'cold') c.temp = sel;
      c.phase = 'choose';
      this.renderComboStep();
      return;
    }

    const ch = this.options[this.cursor].data;
    c.answers[c.ri] = { round: round.name, roundId: round.id, choice: ch.name, code: ch.code || '', diffPrice: ch.diffPrice || '' };
    c.ri++;
    c.phase = 'ask';
    c.temp = null;
    c.spicy = null;
    if (c.ri >= rounds.length) this.renderComboDone();
    else this.renderComboStep();
  },

  renderComboDone() {
    const c = this.combo;
    this.state = 'COMBO_CONFIG';
    this.stepLabel = '第 3 步 / 共 3 步';
    this.title = '套餐已配好';
    this.hint = '长按确认进入结算。';
    this.options = (c.answers || []).map(a => ({ label: a.round + '：' + a.choice, sub: a.diffPrice || '', data: null }));
    if (!this.options.length) this.options = [{ label: c.name, sub: '默认搭配', data: null }];
    this.order = [{ name: c.name, price: c.price, code: c.code, img: null, kind: 'combo', config: c.answers.slice() }];
    this.cursor = 0;
    this.render();
    Voice.speak('套餐已经配好啦。长按确认键，就可以去结算。');
  },

  /* ---------- 结算 / 支付 ---------- */
  orderTotal() { return this.order.reduce((s, x) => s + (Number(x.price) || 0), 0); },

  /* 麦当劳 MCP 返回 {success,code,message,data}，这里统一拆出业务数据 */
  mcpData(r) {
    if (!r) return null;
    if (r.data !== undefined && r.data !== null) return r.data;
    return r;
  },

  /* 把订单转成 MCP create-order / calculate-price 需要的 items 结构
   * 关键：roundList[].round 必须传 round 的 **id（数字）**，传名称会 500
   * （已实测：round=1/2/3 → 计价+建单均通过；round=名称 → 服务端 500） */
  buildMcpItems() {
    const items = [];
    for (const line of this.order) {
      if (!line || !line.code) continue;
      if (line.kind === 'combo') {
        const roundList = (line.config || [])
          .filter((a) => a && a.code && a.roundId != null)
          .map((a) => ({ round: a.roundId, comboItemList: [{ code: a.code, quantity: 1 }] }));
        const it = { productCode: line.code, quantity: 1 };
        if (roundList.length) it.roundList = roundList;
        items.push(it);
      } else {
        items.push({ productCode: line.code, quantity: 1 });
      }
    }
    return items;
  },

  /* 真实下单：calculate-price 计价 → 取 takeWayCode → create-order 建单 */
  async realOrder() {
    const store = (Store.data && Store.data.store && Store.data.store.code) || '3450379';
    const items = this.buildMcpItems();
    if (!items.length) throw new Error('订单里没有可下单的商品');

    const priceRaw = await Store.mcp('calculate-price', { storeCode: store, orderType: 1, beType: 1, items });
    const price = this.mcpData(priceRaw) || {};
    const takeWayList = price.takeWayList || [];
    const takeWayCode = takeWayList[0] && takeWayList[0].code;
    if (!takeWayCode) throw new Error('计价没有返回取餐方式（takeWayList 为空）');
    const realTotal = price.totalPrice != null ? Number(price.totalPrice)
      : (price.price != null ? Number(price.price) : this.orderTotal());

    let orderRaw, usedRound = true;
    try {
      orderRaw = await Store.mcp('create-order', {
        storeCode: store, orderType: 1, beType: 1, takeWayCode, items, needTableware: false,
      });
    } catch (e) {
      // 套餐子项（roundList）若不被接受，退化为只下单套餐本体
      const simple = items.map((i) => ({ productCode: i.productCode, quantity: i.quantity }));
      orderRaw = await Store.mcp('create-order', {
        storeCode: store, orderType: 1, beType: 1, takeWayCode, items: simple, needTableware: false,
      });
      usedRound = false;
    }
    const order = this.mcpData(orderRaw) || {};
    const orderId = order.orderId || order.orderNo || order.id || '';
    if (!orderId) throw new Error('创建订单没有返回订单号');
    return { orderId, realTotal, takeWayCode, usedRound, payUrl: order.payH5Url || order.payUrl || '' };
  },

  /* 支付页按「确认」：模拟 → 直接完成；真实 → 调 MCP 建单后再完成 */
  async submitOrder() {
    if (CONFIG.mockPayment) { this.enterDone(); return; }
    const ov = $('overlay');
    const panel = $('overlay-panel');
    this._submitting = true;
    try {
      // 下单前先确认代理还活着：若之前掉线过，这里立刻重试升级到实时
      if (Store.mode !== 'live') {
        await this.tryUpgradeLive();
        if (Store.mode !== 'live') {
          throw new Error('OFFLINE_PROXY 本地代理未连接，当前是离线快照菜单，无法实时调用');
        }
      }
      if (panel) {
        panel.className = 'panel';
        panel.innerHTML = '<h2>正在向麦当劳下单…</h2><div class="tip">正在调用麦当劳 MCP 创建真实订单，请稍候。</div>';
      }
      Voice.speak('正在创建真实订单，请稍等。');
      const r = await this.realOrder();
      this.lastOrder = {
        total: r.realTotal || this.orderTotal(),
        mock: false, orderId: r.orderId, payUrl: r.payUrl,
        items: this.order.slice(),
      };
      this.enterDone();
    } catch (e) {
      const raw = (e && e.message) || String(e);
      // 把麦当劳的业务错误码 / 环境问题翻译成人话
      const HINT = [
        [/OFFLINE_PROXY|快照模式|无法实时调用/, '本地代理未连接（网页当前在离线快照模式下运行），无法实时下单。请双击项目根目录的「启动麦点点代理.cmd」启动本地代理，然后点右上角「刷新菜单」再试。'],
        [/600039/, '今日下单数已达上限（演示账号每日限额），真实下单需等额度重置。'],
        [/60006\b/, '该商品已售罄或当前不可售，请换一个试试。'],
        [/600053|600057/, '门店未在营业或不在营业时间，无法下单。'],
        [/600064/, '订单已经取消过了。'],
        [/\(500\)|未知的问题/, '麦当劳服务端内部错误，通常是套餐参数不合法。'],
      ];
      let msg = raw;
      let hintFound = false;
      for (const [re, hint] of HINT) if (re.test(raw)) { msg = hint; hintFound = true; break; }
      const quota = /600039/.test(raw);
      const offline = /OFFLINE_PROXY|快照模式|无法实时调用/.test(raw);
      // 这两种情况都能一键退回模拟支付，保证现场流程不卡死
      const canFallback = quota || offline;
      if (panel) {
        panel.className = 'panel';
        panel.innerHTML = `
          <h2>下单失败</h2>
          <div class="tip pay-warn">${esc(msg)}</div>
          <div class="actions">
            <button class="ctl primary" id="ov-ok">重试</button>
            ${canFallback ? '<button class="ctl" id="ov-mock">改为模拟支付演示</button>' : ''}
            <button class="ctl" id="ov-cancel">返回核对</button>
          </div>`;
        if ($('ov-ok')) $('ov-ok').onclick = () => this.onOk();
        if (canFallback && $('ov-mock')) $('ov-mock').onclick = () => {
          CONFIG.mockPayment = true;
          const cb = $('set-mock'); if (cb) cb.checked = true;
          this.enterPay();
        };
        if ($('ov-cancel')) $('ov-cancel').onclick = () => { ov.hidden = true; this.enterCheckout(); };
      }
      Voice.speak('下单失败。' + msg + (canFallback ? '可以选模拟支付继续演示。' : '可以按确认重试。'));
    } finally {
      this._submitting = false;
    }
  },

  enterCheckout() {
    this.state = 'CHECKOUT';
    this.stepLabel = '结算';
    this.title = '确认一下';
    this.hint = `合计 ${fen2yuan(this.orderTotal())}。按确认进入支付。`;
    this.options = this.order.map(x => ({ label: x.name, sub: x.kind === 'combo' ? '套餐' : '单品', price: x.price, img: x.img, data: null }));
    this.cursor = 0;
    this.render();
    Voice.speak(`您一共选了 ${this.order.length} 样，合计 ${fen2speech(this.orderTotal())}。要是没问题，按确认就去付款啦。`);
  },

  enterPay() {
    this.lastOrder = { total: this.orderTotal(), mock: CONFIG.mockPayment, items: this.order.slice() };
    this.state = 'PAY';
    this.renderPayOverlay();
  },

  renderPayOverlay() {
    const o = this.lastOrder || {};
    const ov = $('overlay');
    const panel = $('overlay-panel');
    if (!ov || !panel) return;
    ov.hidden = false;
    panel.className = 'panel';
    const items = (o.items || []).map(it => `
        <li class="pay-item"><span class="pay-item-name">${it.name || '餐品'}</span><span class="pay-item-price">${fen2yuan(it.price)}</span></li>`).join('');
    panel.innerHTML = `
      <h2>${o.mock ? '模拟支付（演示）' : '确认真实下单'}</h2>
      <ul class="pay-list">${items}</ul>
      <div class="big">合计 ${fen2yuan(o.total)}</div>
      ${o.mock
        ? `<canvas class="qr" id="mock-qr" width="220" height="220"></canvas>
           <div class="tip">演示模式，不产生真实扣款。按确认完成下单。</div>`
        : `<div class="tip pay-warn">按「确认」将通过麦当劳 MCP <b>创建一笔真实到店订单</b>（${esc((Store.data && Store.data.store && Store.data.store.name) || '')}）。请确认订单无误后再按。</div>`}
      <div class="actions">
        <button class="ctl primary" id="ov-ok">${o.mock ? '确认（完成下单）' : '确认下单（真实）'}</button>
        <button class="ctl" id="ov-cancel">返回核对</button>
      </div>`;
    if (o.mock && $('mock-qr')) drawMockQr($('mock-qr'));
    if ($('ov-ok')) $('ov-ok').onclick = () => this.onOk();
    if ($('ov-cancel')) $('ov-cancel').onclick = () => { ov.hidden = true; this.enterCheckout(); };
    Voice.speak(o.mock
      ? `请核对您的订单，一共 ${this.order.length} 样，合计 ${fen2speech(o.total)}。确认无误，就按确认完成下单。`
      : `请核对您的订单，一共 ${this.order.length} 样，合计 ${fen2speech(o.total)}。按确认将创建真实订单。`);
  },

  enterDone() {
    this.state = 'DONE';
    const o = this.lastOrder || {};
    const ov = $('overlay');
    const panel = $('overlay-panel');
    if (!ov || !panel) return;
    ov.hidden = false;
    panel.className = 'panel panel--celebrate';
    const realId = o.mock ? '' : (o.orderId || '');
    panel.innerHTML = `
      <div class="celebrate-badge">下单成功</div>
      <h2 class="celebrate-title">祝您用餐愉快</h2>
      <div class="big">合计 ${fen2yuan(o.total)}</div>
      ${realId ? `<div class="order-id">订单号：${esc(realId)}</div>` : ''}
      <div class="tip">${o.mock ? '演示订单，未产生真实扣款。' : '已通过麦当劳 MCP 创建真实到店订单，请到店取餐。'}<br>按确认开始新的一单。</div>
      <div class="actions"><button class="ctl primary" id="ov-ok">开始新的一单</button></div>`;
    if ($('ov-ok')) $('ov-ok').onclick = () => this.onOk();
    Celebrate.burst();
    Voice.speak(o.mock
      ? '下单成功！祝您用餐愉快。按确认，咱们再开一单。'
      : `下单成功，订单号 ${realId}。祝您用餐愉快！按确认，咱们再开一单。`);
  },

  cancelModal() {
    this.modal = null;
    const ov = $('overlay'); if (ov) ov.hidden = true;
    this.render();
  },

  newOrder() {
    this.order = [];
    this.combo = null;
    this.selectedCode = null;
    this.lastOrder = null;
    this.modal = null;
    this.adding = false;
    const ov = $('overlay'); if (ov) ov.hidden = true;
    this.enterEntry();
    Voice.speak('好，咱们开始新的一单。您想点点套餐，还是自己单点？');
  },

  /* ---------- 渲染 ---------- */
  render() {
    const step = $('wiz-step'), title = $('wiz-title'), hint = $('wiz-hint'), list = $('wiz-list');
    if (step) step.textContent = this.stepLabel || '';
    if (title) title.textContent = this.title || '';
    if (hint) hint.textContent = this.hint || '';
    // 屏幕大字：始终显示"当前选中的是哪一个"（语音之外的可见兜底，方便协助者与现场核对）
    const cur = $('wiz-current');
    if (cur) {
      const o = this.options[this.cursor];
      if (o) {
        const pos = this.options.length > 1 ? `　（第 ${this.cursor + 1} 项 / 共 ${this.options.length} 项）` : '';
        cur.textContent = '当前选中：' + o.label + (o.price != null ? '　' + fen2yuan(o.price) : '') + pos;
        cur.hidden = false;
      } else {
        cur.textContent = '';
        cur.hidden = true;
      }
    }
    if (!list) return;
    list.innerHTML = this.options.map((o, i) => {
      const active = i === this.cursor ? ' active' : '';
      const picked = (this.state === 'ITEM_LIST' && this.selectedCode && o.data && o.data.code === this.selectedCode)
        ? '<span class="pick">已选</span>' : '';
      const img = o.img ? `<img class="opt-img" src="${esc(o.img)}" alt="" onerror="this.style.display='none'">` : '';
      const price = (o.price != null) ? `<span class="opt-price">${fen2yuan(o.price)}</span>` : '';
      const sub = o.sub ? `<span class="opt-sub">${esc(o.sub)}</span>` : '';
      return `<li class="opt${active}" data-i="${i}" role="option" aria-selected="${i === this.cursor}">${img}<span class="opt-main"><span class="opt-label">${esc(o.label)}</span>${sub}</span>${price}${picked}</li>`;
    }).join('');
    this.showDebugState();
  },

  speakCurrent(withContext = false) {
    const o = this.options[this.cursor];
    if (!o) return;
    const optText = [o.label, o.price != null ? fen2speech(o.price) : ''].filter(Boolean).join('，');
    // 进入新页面时把“标题 + 当前选项”连成一句，盲用更连贯；移动光标时只播选项
    Voice.speak(withContext ? `${this.title}。${optText}` : optText);
  },

  renderMode() {
    const b = $('mode-badge');
    if (!b) return;
    if (Store.mode === 'live') { b.textContent = '实时菜单'; b.className = 'badge badge-live'; }
    else if (Store.mode === 'cache') { b.textContent = '本地缓存'; b.className = 'badge badge-cache'; }
    else { b.textContent = '离线菜单'; b.className = 'badge badge-snapshot'; }
    const s = Store.data && Store.data.store;
    const sn = $('store-name');
    if (sn) sn.textContent = s && s.name ? ('门店：' + s.name) : '';
  },

  showNetBanner(kind, msg) {
    const el = $('net-banner');
    if (!el) return;
    el.hidden = false;
    el.className = 'net-banner ' + (kind === 'fatal' ? 'fatal' : kind === 'info' ? 'info' : 'warn');
    const m = $('net-banner-msg');
    if (m) m.textContent = msg;
  },

  // 后台静默重试：非实时但已有可用菜单时，每 30s 尝试升级到实时；
  // 成功则更新徽章、隐藏提示并刷新目录，全程不打断用户当前操作
  startNetWatch() {
    if (typeof window === 'undefined' || this._netWatch) return;
    // 立刻探一次：页面在 15 分钟节流窗口内重载时，Store.mode 会停在 'cache'，
    // 这里立即补一次升级，避免"代理明明在跑却提示无法实时调用"。
    this.tryUpgradeLive();
    this._netWatch = setInterval(() => this.tryUpgradeLive(), 30000);
  },

  /* 后台静默升级到实时菜单。
   * 注意：升级成功后**绝不能**重置用户当前的选择与光标位置
   * （旧实现在这里调 enterEntry()，会每 30s 把光标拉回「套餐」，导致上下键像是失灵）。 */
  async tryUpgradeLive() {
    if (Store.mode === 'live') return false;
    try {
      const live = await Store.tryLive();
      if (!live) return false;
      Store.applyData(live);
      Store.mode = 'live';
      Store.lastRefreshTs = Date.now();
      Store.writeLocalCache(live);
      Store.networkWarning = false;
      this.renderMode();
      const b = $('net-banner');
      if (b) b.hidden = true;
      Catalog.build();
      // 只在“还没有任何选项”时重建页面；否则保留用户当前选择与光标
      if (!this.options.length) this.enterEntry(); else this.render();
      return true;
    } catch (e) { return false; }
  },

  async refreshMenu() {
    const now = Date.now();
    if (this._lastManual && now - this._lastManual < CONFIG.manualCooldownMs) { toast('刷新太频繁，请稍后再试'); return; }
    this._lastManual = now;
    toast('正在刷新实时菜单…');
    try {
      await Store.load({ force: true, onUpgrade: () => this.renderMode() });
      this.renderMode();
      if (Store.mode === 'live') toast('已更新为实时菜单');
      else toast('仍使用本地缓存菜单');
    } catch (e) { toast('刷新失败：数据网络异常'); }
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
