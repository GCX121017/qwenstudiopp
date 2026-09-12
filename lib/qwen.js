// Qwen Studio++ - Qwen Studio (chat.qwen.ai) 逆向客户端
// 协议要点 (实测校准 2026-09):
//  - 认证: Authorization: Bearer <JWT> + Cookie: token=<JWT> 双保险
//  - 建聊天: POST /api/v2/chats/new -> data.id (自造 UUID 会 CHAT_NOT_FOUND)
//  - completion: messages 仅允许 1 条; 多轮用 "对话历史拼接" (flat) 策略
//  - SSE: phase=thinking_summary(快照式,需去重) / phase=answer(真增量) / phase=web_search(防御性解析, 默认关闭联网)
//  - 请求头缺 Timezone 等会"静默挂起" (无响应永不超时) -> 必须全量携带 + 响应头超时保护
//  - 高频调用触发 Baxia 滑块风控 -> 客户端节流
'use strict';
const { QwenError, safeStr, sleep, nowSec, uuid } = require('./util');
const QWEN_BASE = 'https://chat.qwen.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// IPv6/IPv4 自动选择: 部分国内网络环境 DNS 返回 AAAA 但 IPv6 路由不通(黑洞),
// Node 默认逐个等待会直到 ETIMEDOUT。开启 happy-eyeballs(Node 20.7+) 双栈并行竞速, v4 不通时自动回退。
try {
  const net = require('net');
  if (typeof net.setDefaultAutoSelectFamily === 'function') net.setDefaultAutoSelectFamily(true);
} catch (e) { /* 老版本 Node 无此 API, 忽略 */ }

// fetch failed 是笼统报错, 真实原因在 e.cause 里(ECONNREFUSED/ENOTFOUND/ETIMEDOUT...),
// 必须透传给用户并附中文对策, 否则远程无法排查。
function describeFetchError(e) {
  const base = (e && e.message) || 'fetch failed';
  const c = e && (e.cause || e);
  const code = (c && (c.code || c.name)) || '';
  const cmsg = (c && c.message) || '';
  let detail = cmsg || code;
  if (cmsg && code && !cmsg.includes(code)) detail = code + ' ' + cmsg;
  let hint = '';
  if (code === 'ENOTFOUND') hint = '(DNS 解析失败: 域名无法解析, 检查网络/DNS, 可尝试切换手机热点验证)';
  else if (code === 'ECONNREFUSED') hint = '(连接被拒绝: 常见于本机代理软件已关闭但系统代理仍指向它, 或防火墙拦截)';
  else if (code === 'ECONNRESET' || code === 'EPIPE') hint = '(连接被重置: 网络中途断开, 常见于代理拦截或网络限制)';
  else if (code === 'ETIMEDOUT' || /timed? ?out|timeout/i.test(cmsg)) hint = '(连接超时: 常见于防火墙拦截 node.exe 或网络不通, 检查 Windows 防火墙放行)';
  else if (/CERT|certificate|SSL|TLS/i.test(code + ' ' + cmsg)) hint = '(TLS 证书校验失败: 检查系统时间是否正确, 安全软件是否拦截 HTTPS)';
  else if (code === 'EAI_AGAIN') hint = '(DNS 暂时不可用: 网络不稳定或 DNS 服务器无响应)';
  else if (code === 'AbortError' || /aborted/i.test(cmsg + code)) hint = '(请求超时被中止: 网络过慢或服务端无响应)';
  return detail ? (base + ' [' + detail + ']' + (hint ? ' ' + hint : '')) : (base + (hint ? ' ' + hint : ''));
}

// 时区头取值: 必须纯 ASCII。
// 中文 Windows 上 new Date().toString() 返回 "...GMT+0800 (中国标准时间)",
// 括号内时区名跟随系统区域语言 -> 头值含中文 -> undici 抛 ByteString
// (报错中 index 35 = "中", value 20013 = U+4E2D; "Fri Sep 12 2026 HH:MM:SS GMT+0800 (" 恒为 35 字符)。
// 这就是 v1.1.3 及之前 "ByteString index 35" 报错的真正根因, 与 token 无关。
// 修复: 时区名强制用 en-US 输出 (如 "China Standard Time"); 取不到时退回手工计算的 GMT 偏移。
function asciiTimezoneHeader() {
  const d = new Date();
  let name = '';
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' })
      .formatToParts(d).find(x => x.type === 'timeZoneName');
    if (p && /^[\u0000-\u00FF]*$/.test(p.value)) name = p.value;
  } catch (e) { /* Intl 异常时走 GMT 偏移兜底 */ }
  if (name) {
    const s = d.toString();
    return /\(.*\)\s*$/.test(s)
      ? s.replace(/\(.*\)\s*$/, '(' + name + ')')
      : s + ' (' + name + ')';
  }
  const off = -d.getTimezoneOffset();          // 东八区 -> 480
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return 'GMT' + sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
}

// 全局节流状态: 所有 client 实例共享 (每个 API 请求都会新建 client, 若实例化则限流失效)
const _throttleState = { lastCallAt: 0 };

const FALLBACK_MODELS = [
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max' },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus' },
  { id: 'qwen3.5-plus', name: 'Qwen3.5-Plus' },
  { id: 'qwen3.5-omni-plus', name: 'Qwen3.5-Omni-Plus' }
];

// ---------------- SSE 事件解析器 (有状态, 支持跨 chunk 行缓冲) ----------------
// 产出事件:
//  {type:'created', chatId, responseId}
//  {type:'thinking', delta}           思考摘要新增文本(已做快照去重)
//  {type:'step', titles:[...]}        思考步骤标题(最新全量)
//  {type:'search_queries', queries}   联网搜索词
//  {type:'search_docs', docs}         搜索结果(模型看到的, 全局编号去重后)
//  {type:'content', delta}            正文增量(真增量)
//  {type:'done', usage}               流结束
class QwenSseParser {
  constructor() {
    this.buf = '';
    this.think = '';          // 思考全文 (快照去重基准)
    this.steps = [];          // 步骤标题
    this.queries = '';        // function_call.arguments 拼接缓冲
    this.docsByUrl = new Map();
    this.usage = null;
  }

  // 喂入 chunk, 返回事件数组
  feed(chunk) {
    this.buf += chunk;
    const events = [];
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { continue; }
      events.push(...this.handle(obj));
    }
    return events;
  }

  handle(obj) {
    const out = [];
    if (obj.usage) this.usage = obj.usage;

    // 流中错误帧 (v1.1.7): 风控/服务端异常常以 success:false 或 error 字段出现(无 choices),
    // 旧版本直接丢弃导致流"戛然而止", 客户端只能看到空回复或 [object Object]
    if (obj.success === false || obj.error || (obj.code != null && obj.message != null && !obj.choices)) {
      const d = obj.data || {};
      out.push({
        type: 'upstream_error',
        code: String(obj.code || d.code || (obj.error && obj.error.code) || 'UPSTREAM_ERROR'),
        message: safeStr(
          obj.message || (obj.error && (obj.error.message || obj.error)) || d.details || d.message || obj, 400)
      });
      return out;
    }

    // 生命周期
    if (obj['response.created']) {
      const rc = obj['response.created'];
      out.push({ type: 'created', chatId: rc.chat_id, responseId: rc.response_id });
    }
    if (obj['response.completed']) {
      out.push({ type: 'completed' });
    }

    const ch = obj.choices;
    if (!Array.isArray(ch) || !ch.length) return out;
    const d = ch[0].delta || {};
    const phase = d.phase || '';

    if (phase === 'thinking_summary') {
      // 快照式: summary_thought.content 是整段全文重复推送
      const st = (d.extra && d.extra.summary_thought && d.extra.summary_thought.content) || [];
      const full = st.join('');
      if (full) {
        let delta = '';
        if (full === this.think) delta = '';
        else if (this.think && full.startsWith(this.think)) { delta = full.slice(this.think.length); this.think = full; }
        else if (!this.think) { delta = full; this.think = full; }
        else { delta = full; this.think = full; } // 快照变化无法前缀匹配 -> 全量覆盖式追加
        if (delta) out.push({ type: 'thinking', delta });
      }
      const ti = d.extra && d.extra.summary_title && d.extra.summary_title.content;
      if (Array.isArray(ti)) {
        const joined = ti.join('\n');
        if (joined !== this.steps.join('\n')) {
          this.steps = ti.slice();
          out.push({ type: 'step', titles: this.steps });
        }
      }
      return out;
    }

    if (phase === 'web_search') {
      const status = d.status || '';
      if (status === 'typing') {
        // function_call.arguments 增量拼接 -> queries JSON
        const fc = d.function_call;
        if (fc && fc.arguments) this.queries += fc.arguments;
      } else if (status === 'finished') {
        if (this.queries) {
          try {
            const q = JSON.parse(this.queries);
            if (q && Array.isArray(q.queries)) out.push({ type: 'search_queries', queries: q.queries });
          } catch (e) { /* 忽略拼接失败 */ }
          this.queries = '';
        }
        const tr = d.extra && d.extra.tool_result;
        if (tr && Array.isArray(tr.docs)) {
          const fresh = [];
          for (const doc of tr.docs) {
            const url = doc.url || '';
            if (!url || this.docsByUrl.has(url)) continue;
            const item = {
              idx: this.docsByUrl.size + 1,
              url, title: doc.title || url,
              snippet: doc.snippet || '',
              hostname: doc.hostname || ''
            };
            this.docsByUrl.set(url, item);
            fresh.push(item);
          }
          if (fresh.length) out.push({ type: 'search_docs', docs: fresh });
        }
      }
      return out;
    }

    // 正文: phase === 'answer' (实测校准: 旧笔记"phase为空"不准确)
    if (phase === 'answer' && d.content) {
      out.push({ type: 'content', delta: d.content });
      return out;
    }
    // 兜底: 无 phase 但有 content (老版本格式)
    if (!phase && d.content && d.role === 'assistant') {
      out.push({ type: 'content', delta: d.content });
    }
    return out;
  }
}

// ---------------- Qwen 客户端 ----------------
class QwenClient {
  /**
   * @param {object} cfg { qwenToken, throttleMs }
   */
  constructor(cfg) {
    this.cfg = cfg;
  }

  headers(extra) {
    const token = String(this.cfg.qwenToken || '').trim();
    const h = Object.assign({
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': uuid(),
      'Version': '0.2.91',
      'source': 'web',
      'Timezone': asciiTimezoneHeader(),
      'User-Agent': UA,
      'Origin': QWEN_BASE,
      'Referer': QWEN_BASE + '/'
    }, extra || {});
    if (token) {
      // 兜底防御: HTTP 头只允许 Latin-1 字符, 含中文/表情会抛难以理解的 ByteString 错误
      // (正常路径已在 config.sanitizeQwenToken 清洗过, 这里防旧配置/旁路调用)
      if (/[^\u0000-\u00FF]/.test(token)) {
        throw new QwenError('TOKEN_INVALID_CHARS',
          'token 含中文或非拉丁字符，无法用于请求头。请在管理页重新粘贴: 打开 chat.qwen.ai → F12 → Console 输入 localStorage.token，只复制 eyJ 开头的字符串本体', 400);
      }
      if (/^eyJ/.test(token)) {
        h['Authorization'] = 'Bearer ' + token;
        h['Cookie'] = 'token=' + token;
      } else {
        h['Cookie'] = token; // 整段 Cookie 串
      }
    }
    // 出站前最后防线: 逐个扫描全部头值, 非 Latin-1 直接点名拦截。
    // (undici 原生 ByteString 报错不含头名, 极难排查; v1.1.4 起该原始报错在物理上不可能再出现)
    for (const k of Object.keys(h)) {
      if (/[^\u0000-\u00FF]/.test(String(h[k]))) {
        throw new QwenError('HEADER_INVALID_CHARS',
          '请求头 "' + k + '" 含中文或非拉丁字符, 已在本地拦截(未发往服务端)。若反复出现请截图反馈', 400);
      }
    }
    return h;
  }

  hasToken() { return !!String(this.cfg.qwenToken || '').trim(); }

  // 节流: 距上次 Qwen 请求不足 throttleMs 则等待 (全局共享状态)
  async throttle() {
    const gap = Number(this.cfg.throttleMs) || 0;
    if (gap > 0) {
      const wait = gap - (Date.now() - _throttleState.lastCallAt);
      if (wait > 0) await sleep(wait);
    }
    _throttleState.lastCallAt = Date.now();
  }

  // 统一请求: 带响应头超时(防静默挂起) + 错误归一化
  // ⚠ 超时只允许覆盖"响应头阶段": AbortSignal.timeout 会连正文流一起割断,
  //   长回答必然在 90s 被硬切(用户实测 v1.1.6: 思考流到 1分33秒 报错, 90s 超时+开销分秒不差)。
  //   改用手动 AbortController, 响应头一到立刻 clearTimeout, 正文由 chatStream 的硬上限/看门狗管。
  async request(pathname, options) {
    if (!this.hasToken()) throw new QwenError('NO_TOKEN', 'Qwen token 未配置, 请在管理页设置', 401);
    await this.throttle();
    const headerTimeout = options.headerTimeoutMs || 30000;
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(
      new QwenError('NETWORK_TIMEOUT', '服务器 ' + Math.round(headerTimeout / 1000) + ' 秒内未返回响应头(静默挂起保护触发)')), headerTimeout);
    let resp;
    try {
      resp = await fetch(QWEN_BASE + pathname, {
        method: options.method || 'GET',
        headers: this.headers(options.extraHeaders),
        body: options.body,
        signal: ctrl.signal
      });
    } catch (e) {
      if (e instanceof QwenError) throw e; // 业务错误(如 token 含中文)原样透传, 不再包成 NETWORK
      if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
        throw new QwenError('NETWORK_TIMEOUT', '服务器 ' + Math.round(headerTimeout / 1000) + ' 秒内未返回响应头(静默挂起保护触发)。Qwen 偶发无响应, 稍后重试; 若反复出现请检查网络代理', 502);
      }
      throw new QwenError('NETWORK', '无法连接 chat.qwen.ai: ' + describeFetchError(e), 502);
    } finally {
      clearTimeout(abortTimer); // 响应头已到(或已失败), 正文流不再受此超时约束
    }
    // 静默挂起保护: 30s 内没有响应头即上面 timeout; 这里再校验状态
    return resp;
  }

  // 模型列表
  async listModels() {
    const resp = await this.request('/api/v2/models/', { method: 'GET' });
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      throw new QwenError('AUTH_FAILED', 'Token 无效或已过期 (HTTP ' + resp.status + '), 请重新获取', 401);
    }
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new QwenError('BAD_RESPONSE', '模型列表响应异常: ' + text.slice(0, 120), 502); }
    let items = [];
    if (body && body.data) {
      if (Array.isArray(body.data)) items = body.data;
      else if (Array.isArray(body.data.data)) items = body.data.data;
    } else if (Array.isArray(body)) items = body;
    const models = items.map(m => ({
      id: m.id,
      name: m.name || m.id,
      description: (m.info && m.info.meta && m.info.meta.description) || '',
      capabilities: (m.info && m.info.meta && m.info.meta.capabilities) || {}
    })).filter(m => m.id);
    if (!models.length) throw new QwenError('BAD_RESPONSE', '模型列表为空, token 可能已失效', 502);
    return models;
  }

  // 新建聊天 -> chat_id (必须用服务端返回的 id)
  async createChat(model) {
    const resp = await this.request('/api/v2/chats/new', {
      method: 'POST',
      body: JSON.stringify({
        chatId: '',
        models: [model],
        project_id: '',
        timestamp: Date.now(),   // 注意: 此处为毫秒
        chat_type: 't2t',
        chat_mode: 'normal'
      })
    });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { throw new QwenError('BAD_RESPONSE', '创建聊天失败: ' + text.slice(0, 120), 502); }
    if (body.success === false) {
      const code = (body.data && body.data.code) || body.code || 'CREATE_CHAT_FAIL';
      const details = safeStr((body.data && body.data.details) || body.message || '', 300);
      if (resp.status === 401 || resp.status === 403 || /unauthorized|token/i.test(details)) {
        throw new QwenError('AUTH_FAILED', 'Token 无效或已过期: ' + details, 401);
      }
      throw new QwenError(code, '创建聊天失败: ' + (details || code), 502);
    }
    const id = (body.data && body.data.id) || body.id || (body.data && body.data.data && body.data.data.id);
    if (!id) throw new QwenError('BAD_RESPONSE', '创建聊天未返回 id: ' + JSON.stringify(body).slice(0, 120), 502);
    return id;
  }

  // 多轮消息 -> Qwen 单条消息内容 (flat 拼接策略)
  static buildFlatContent(messages) {
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).filter(Boolean).join('\n\n');
    const turn = messages.filter(m => m.role !== 'system');
    if (!turn.length) throw new QwenError('BAD_REQUEST', 'messages 不能为空', 400);
    if (turn.length === 1 && turn[0].role === 'user') {
      return sys ? ('[System Instructions]\n' + sys + '\n\n' + turn[0].content) : String(turn[0].content);
    }
    const last = turn[turn.length - 1];
    const hist = turn.slice(0, -1);
    let s = '';
    if (sys) s += '[System Instructions]\n' + sys + '\n\n';
    s += '[Conversation History]\n';
    for (const m of hist) {
      const role = m.role === 'assistant' ? 'Assistant' : 'User';
      s += '\n' + role + ': ' + String(m.content == null ? '' : m.content) + '\n';
    }
    s += '\nBased on the conversation history above, respond directly to the user\'s latest message. Answer in the same language as the user. Do not repeat or mention this instruction.\n\n';
    s += 'User: ' + String(last.content == null ? '' : last.content);
    return s;
  }

  /**
   * 流式对话
   * @param {object} p {model, messages, thinking, onEvent}
   *   onEvent(evt) 回调接收解析后的事件; 返回 Promise resolves {answer, thinking, steps, docs, queries, usage}
   */
  async chatStream(p) {
    const model = p.model || 'qwen3.8-max';
    const content = QwenClient.buildFlatContent(p.messages);
    const chatId = await this.createChat(model);
    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chatId: chatId,
      chat_id: chatId,
      parentId: '',        // 首条消息必须为空字符串 (null 会挂起)
      parent_id: '',
      chat_mode: 'normal',
      model: model,
      messages: [{
        id: null,
        fid: uuid(),
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: content,
        user_action: 'chat',
        files: [],
        timestamp: nowSec(),
        models: [model],
        model: '',
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: p.thinking !== false,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: p.thinking !== false,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: false   // 纯 API 包装, 不启用联网搜索
        },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: null
      }],
      timestamp: nowSec()
    };

    const resp = await this.request('/api/v2/chat/completions?chat_id=' + encodeURIComponent(chatId), {
      method: 'POST',
      body: JSON.stringify(payload),
      extraHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      headerTimeoutMs: 30000
    });

    const ct = resp.headers.get('content-type') || '';
    const rawText = async () => { try { return await resp.text(); } catch (e) { return ''; } };

    if (resp.status !== 200) {
      const t = await rawText();
      if (resp.status === 401 || resp.status === 403) throw new QwenError('AUTH_FAILED', 'Token 无效或已过期 (HTTP ' + resp.status + ')', 401);
      throw new QwenError('UPSTREAM_' + resp.status, 'Qwen 返回 HTTP ' + resp.status + ': ' + t.slice(0, 150), 502);
    }
    // Qwen 有时用 HTTP 200 返回 JSON 错误体
    if (!ct.includes('event-stream') && !ct.includes('text/')) {
      const t = await rawText();
      let code = 'UPSTREAM_ERROR', details = t.slice(0, 200);
      try {
        const j = JSON.parse(t);
        code = (j.data && j.data.code) || j.code || code;
        details = safeStr((j.data && j.data.details) || j.details || j.message, 300) || details;
        if (/token|unauthorized/i.test(details + code)) throw new QwenError('AUTH_FAILED', 'Token 无效或已过期: ' + details, 401);
      } catch (e) { if (e instanceof QwenError) throw e; }
      throw new QwenError(code, 'Qwen 拒绝请求: ' + details, 502);
    }

    // ---- 流式读取 ----
    const parser = new QwenSseParser();
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let answer = '';
    const docList = [];
    let queries = [];
    // 硬上限 + 看门狗: 10 分钟强制收尾; 流中途 3 分钟无新数据(连接停滞/风控掐断不挥手)主动取消
    let hardFired = false, lastDataAt = Date.now();
    const hardTimer = setTimeout(() => { hardFired = true; try { reader.cancel('hard-timeout'); } catch (e) {} }, 600000);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastDataAt > 180000) { try { reader.cancel('idle-timeout'); } catch (e) {} }
    }, 5000);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastDataAt = Date.now();
        const events = parser.feed(dec.decode(value, { stream: true }));
        for (const evt of events) {
          switch (evt.type) {
            case 'content':
              answer += evt.delta;
              break;
            case 'search_docs':
              docList.push(...evt.docs);
              break;
            case 'search_queries':
              queries = evt.queries;
              break;
            case 'upstream_error':
              // 上游在流中明确报错 (风控/服务端异常): 把真实错误透传给客户端
              throw new QwenError(evt.code || 'UPSTREAM_ERROR',
                'Qwen 流中返回错误: ' + evt.message
                + (parser.think ? ' (思考已输出 ' + parser.think.length + ' 字)' : '')
                + (answer ? ' (正文已接收 ' + answer.length + ' 字, 客户端已保留)' : '')
                + '。若为风控/频率限制: 请在浏览器打开 chat.qwen.ai 完成滑块验证或冷却几分钟后重试', 502);
          }
          if (typeof p.onEvent === 'function') {
            try { p.onEvent(evt); } catch (e) { /* 回调异常不中断流 */ }
          }
        }
      }
    } finally {
      clearTimeout(hardTimer);
      clearInterval(idleTimer);
    }

    // 收尾校验 (v1.1.7): 流结束却没有正文 = 被上游掐断/提前关闭, 旧版本静默返回空回复, 用户无从排查
    if (!answer) {
      const rest = parser.buf.trim();
      if (!parser.think && rest && /"success"\s*:\s*false/.test(rest)) {
        let code = 'UPSTREAM_ERROR', details = rest.slice(0, 200);
        try {
          const j = JSON.parse(rest.replace(/^data:\s*/, ''));
          code = (j.data && j.data.code) || j.code || code;
          details = safeStr((j.data && j.data.details) || j.details || j.message, 300) || details;
        } catch (e) {}
        throw new QwenError(code, 'Qwen 拒绝请求: ' + details, 502);
      }
      const why = hardFired ? '(达到 10 分钟硬上限被本地中止)' : '(连接提前关闭)';
      if (!parser.think) {
        throw new QwenError('UPSTREAM_EMPTY',
          '上游未返回任何内容' + why + (rest ? ', 流尾部: ' + safeStr(rest, 200) : '')
          + '。常见原因: 触发 Qwen 风控——请在浏览器打开 chat.qwen.ai 完成滑块验证或冷却几分钟后重试', 502);
      }
      throw new QwenError('UPSTREAM_TRUNCATED',
        '思考完成后上游中断, 未输出正文 (已接收思考 ' + parser.think.length + ' 字' + why + (rest ? ', 流尾部: ' + safeStr(rest, 200) : '') + ')'
        + '。常见原因: 触发 Qwen 风控或连接被重置——请在浏览器打开 chat.qwen.ai 完成滑块验证/冷却几分钟再试; 反复出现请降低调用频率', 502);
    }
    if (hardFired) {
      process.stderr.write('[qwen] 警告: 达到 10 分钟硬上限, 已保留部分正文 (' + answer.length + ' 字)\n');
    }

    return {
      chatId,
      answer: answer.trim(),
      thinking: (parser.think || '').trim(),
      steps: parser.steps,
      docs: docList,
      queries,
      usage: parser.usage,
      model
    };
  }
}

module.exports = { QwenClient, QwenSseParser, QwenError, FALLBACK_MODELS, QWEN_BASE, describeFetchError };
