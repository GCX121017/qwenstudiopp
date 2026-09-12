// Qwen Studio++ - HTTP 服务
//  - /v1/models, /v1/chat/completions  完整 OpenAI Completion 兼容 (流式/非流式)
//  - /admin/*                          Web UI 管理接口
//  - /                                 管理页面
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfgMod = require('./config');
const { QwenClient, QwenError, FALLBACK_MODELS } = require('./qwen');
const { json, readBody, sseWrite, uuid, nowSec, normalizeError } = require('./util');
const VERSION = cfgMod.VERSION;

const state = {
  startTime: Date.now(),
  qwenOk: null,          // null=未检测 true/false
  qwenCheckAt: 0,
  modelsCache: null,
  reqCount: 0
};

function newClient(cfg) {
  return new QwenClient({ qwenToken: cfg.qwenToken, throttleMs: cfg.throttleMs });
}

// ---------------- 鉴权 ----------------
function checkAuth(req, cfg) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  const key = m ? m[1].trim() : '';
  if (!key || key !== cfg.apiKey) return false;
  return true;
}

// DNS-rebinding 防护: 管理接口仅接受本机 host
function adminHostOk(req) {
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function cors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function logReq(method, url, status, ms, note) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] ${method} ${url} -> ${status} (${ms}ms)${note ? ' ' + note : ''}`);
}

// ---------------- OpenAI 兼容 ----------------
function openaiModels(models) {
  const data = models.map(m => ({
    id: m.id,
    object: 'model',
    created: 1700000000,
    owned_by: 'qwen-studio-pp'
  }));
  return { object: 'list', data };
}

function chunkFrame(id, model, delta, finishReason, usage) {
  const frame = {
    id,
    object: 'chat.completion.chunk',
    created: nowSec(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
  if (usage) frame.usage = usage;
  return frame;
}

// 真流式版本: 边收 Qwen 边推 OpenAI chunk
async function streamChatCompletions(req, res, cfg, body) {
  const t0 = Date.now();
  const client = newClient(cfg);
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    return json(res, 400, { error: { message: 'messages is required', type: 'invalid_request_error', code: 'bad_request' } });
  }
  for (const m of messages) {
    if (Array.isArray(m.content)) m.content = m.content.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
    if (m.content == null) m.content = '';
    if (!['user', 'assistant', 'system', 'tool'].includes(m.role)) m.role = 'user';
  }
  const model = (typeof body.model === 'string' && body.model) ? body.model : cfg.defaultModel;
  const thinking = body.thinking !== undefined ? body.thinking !== false : cfg.thinking !== false;
  const id = 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (delta, fr, u) => {
    res.write('data: ' + JSON.stringify(chunkFrame(id, model, delta, fr, u)) + '\n\n');
  };

  send({ role: 'assistant', content: '' }, null);
  let usage = null;
  let answerLen = 0;
  try {
    const result = await client.chatStream({
      model, messages, thinking,
      onEvent: (evt) => {
        if (evt.type === 'thinking') {
          send({ reasoning_content: evt.delta }, null);
        } else if (evt.type === 'content') {
          answerLen += evt.delta.length;
          send({ content: evt.delta }, null);
        } else if (evt.type === 'completed') {
          // usage 在 parser 中持续更新, 最终以返回值为准
        }
      }
    });
    usage = {
      prompt_tokens: (result.usage && (result.usage.input_tokens || result.usage.prompt_tokens)) || 0,
      completion_tokens: (result.usage && (result.usage.output_tokens || result.usage.completion_tokens)) || 0,
      total_tokens: (result.usage && result.usage.total_tokens) || 0
    };
    if (!answerLen && result.answer) {
      // 罕见: 事件没推正文但聚合有 (防御)
      send({ content: result.answer }, null);
    }
    send({}, 'stop', usage);
  } catch (e) {
    // v1.1.8 normalizeError: 保证 error 帧 code/message/status 全为非空基本类型,
    // 杜绝客户端拿到缺字段对象后拼出 "null: [object Object]" 之类失真报错
    const err = normalizeError(e);
    res.write('data: ' + JSON.stringify({ error: { message: err.message, type: 'api_error', code: err.code, status: err.status } }) + '\n\n');
    logReq(req.method, req.url, err.status, Date.now() - t0, '[' + err.code + ']');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.write('data: [DONE]\n\n');
  res.end();
  logReq(req.method, req.url, 200, Date.now() - t0, answerLen + 'ch');
}

// ---------------- 管理接口 ----------------
async function handleAdmin(req, res, cfg, pathname, body) {
  const cfgPath = cfgMod.CONFIG_FILE;

  // GET /admin/api/status
  if (req.method === 'GET' && pathname === '/admin/api/status') {
    const models = state.modelsCache || FALLBACK_MODELS.map(m => ({ id: m.id, name: m.name }));
    return json(res, 200, {
      version: VERSION,
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      port: cfg.port,
      host: cfg.host,
      configPath: cfgPath,
      hasToken: !!cfg.qwenToken,
      tokenMask: cfg.qwenToken ? cfgMod.maskToken(cfg.qwenToken) : '',
      tokenType: cfgMod.detectTokenType(cfg.qwenToken),
      apiKey: cfg.apiKey,
      defaultModel: cfg.defaultModel,
      thinking: cfg.thinking,
      throttleMs: cfg.throttleMs,
      autoOpen: cfg.autoOpen,
      qwenOk: state.qwenOk,
      qwenCheckAt: state.qwenCheckAt,
      models,
      reqCount: state.reqCount
    });
  }

  // GET /admin/api/net-diag - 四步网络诊断 (DNS -> TCP -> TLS -> HTTPS), 定位 fetch failed 卡在哪一层
  if (req.method === 'GET' && pathname === '/admin/api/net-diag') {
    const HOST = 'chat.qwen.ai';
    const dnsProm = require('dns').promises;
    const netMod = require('net');
    const tlsMod = require('tls');
    const steps = [];
    let hint = '';
    const push = (name, ok, t0, detail) => steps.push({ name, ok, ms: Date.now() - t0, detail: String(detail).slice(0, 180) });

    // 1) DNS
    {
      const t0 = Date.now();
      try {
        const addrs = await dnsProm.lookup(HOST, { all: true });
        push('DNS 解析', true, t0, addrs.map(a => a.address + (a.family === 6 ? ' (IPv6)' : '')).join(', ') || '无记录');
      } catch (e) {
        push('DNS 解析', false, t0, (e.code || '') + ' ' + (e.message || ''));
        return json(res, 200, { ok: false, host: HOST, steps, hint: 'DNS 无法解析域名: 先确认电脑能正常上网(能否打开其他网站); 可尝试更换 DNS(如 223.5.5.5 / 114.114.114.114)或用手机热点对照测试' });
      }
    }
    // 2) TCP 443
    {
      const t0 = Date.now();
      try {
        await new Promise((resolve, reject) => {
          const s = netMod.connect({ host: HOST, port: 443 });
          const to = setTimeout(() => { try { s.destroy(); } catch (e) {} reject(Object.assign(new Error('connect timeout (5s)'), { code: 'ETIMEDOUT' })); }, 5000);
          s.once('connect', () => { clearTimeout(to); s.destroy(); resolve(); });
          s.once('error', e => { clearTimeout(to); reject(e); });
        });
        push('TCP 连接 443', true, t0, '已建立');
      } catch (e) {
        push('TCP 连接 443', false, t0, (e.code || '') + ' ' + (e.message || ''));
        const why = e.code === 'ECONNREFUSED' ? '连接被拒绝' : e.code === 'ETIMEDOUT' ? '连接超时' : '网络异常';
        return json(res, 200, { ok: false, host: HOST, steps, hint: 'TCP ' + why + ': 最常见原因是 Windows 防火墙拦截了 node.exe 出站(首次启动弹窗点了"取消"就会被拦, 需在防火墙设置中放行), 其次是代理软件/安全软件拦截' });
      }
    }
    // 3) TLS
    {
      const t0 = Date.now();
      try {
        const info = await new Promise((resolve, reject) => {
          const s = tlsMod.connect({ host: HOST, port: 443, servername: HOST, timeout: 6000 }, () => {
            const cert = s.getPeerCertificate();
            const r = { proto: s.getProtocol(), validTo: cert && cert.valid_to };
            try { s.destroy(); } catch (e) {}
            resolve(r);
          });
          s.once('error', e => reject(e));
          s.once('timeout', () => { try { s.destroy(); } catch (e) {} reject(Object.assign(new Error('tls timeout (6s)'), { code: 'ETIMEDOUT' })); });
        });
        push('TLS 握手', true, t0, (info.proto || '') + (info.validTo ? ', 证书至 ' + info.validTo : ''));
      } catch (e) {
        push('TLS 握手', false, t0, (e.code || '') + ' ' + (e.message || ''));
        return json(res, 200, { ok: false, host: HOST, steps, hint: 'TLS 握手失败: 检查 Windows 系统时间是否正确(证书校验依赖时间); 杀毒/网络管家类安全软件可能拦截 HTTPS, 尝试暂时退出后重试' });
      }
    }
    // 4) HTTPS (拿到任意 HTTP 响应即网络通畅; 401 是未带 token 时的预期)
    {
      const t0 = Date.now();
      try {
        const r = await fetch('https://' + HOST + '/api/v2/models/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' }, signal: AbortSignal.timeout(10000) });
        push('HTTPS 请求', true, t0, 'HTTP ' + r.status + ' (网络通畅)');
      } catch (e) {
        push('HTTPS 请求', false, t0, ((e.cause && e.cause.code) || e.code || '') + ' ' + (e.message || ''));
        return json(res, 200, { ok: false, host: HOST, steps, hint: 'DNS/TCP/TLS 都通但 HTTPS 失败(罕见): 请把本页截图反馈' });
      }
    }
    return json(res, 200, { ok: true, host: HOST, steps, hint: '本机到 chat.qwen.ai 网络全通。若保存 token 仍报错, 问题与网络无关, 请把报错文本发来' });
  }

  // POST /admin/api/token {token}
  if (req.method === 'POST' && pathname === '/admin/api/token') {
    const san = cfgMod.sanitizeQwenToken(String(body.token || ''));
    if (!san.ok) return json(res, 400, { ok: false, message: san.message });
    const token = san.token;
    // 立即验证
    const testClient = new QwenClient({ qwenToken: token, throttleMs: 0 });
    try {
      const models = await testClient.listModels();
      state.modelsCache = models;
      state.qwenOk = true;
      state.qwenCheckAt = Date.now();
      cfgMod.update({ qwenToken: token });
      const fresh = cfgMod.load();
      state.client = newClient(fresh);
      const note = san.note ? '。' + san.note : '';
      return json(res, 200, { ok: true, message: '验证通过, 已保存 (' + models.length + ' 个模型可用)' + note, models: models.map(m => m.id) });
    } catch (e) {
      state.qwenOk = false;
      state.qwenCheckAt = Date.now();
      return json(res, 200, { ok: false, message: e.message });
    }
  }

  // POST /admin/api/test-chat {message, model, thinking} -> SSE 事件流 (管理页在线测试)
  if (req.method === 'POST' && pathname === '/admin/api/test-chat') {
    const fresh = cfgMod.load();
    if (!fresh.qwenToken) return json(res, 400, { ok: false, message: '请先配置 Qwen token' });
    const message = String(body.message || '').trim();
    if (!message) return json(res, 400, { ok: false, message: '消息不能为空' });
    const client = newClient(fresh);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const t0 = Date.now();
    let firstTok = 0;
    try {
      const result = await client.chatStream({
        model: body.model || fresh.defaultModel,
        messages: [{ role: 'user', content: message }],
        thinking: body.thinking !== false,
        onEvent: (evt) => {
          if ((evt.type === 'content' || evt.type === 'thinking') && !firstTok) firstTok = Date.now() - t0;
          sseWrite(res, evt.type, evt);
        }
      });
      sseWrite(res, 'done', {
        answer: result.answer,
        thinking: result.thinking,
        steps: result.steps,
        docs: result.docs,
        queries: result.queries,
        usage: result.usage,
        elapsed: Date.now() - t0,
        firstTok
      });
    } catch (e) {
      sseWrite(res, 'error', normalizeError(e));
    }
    res.end();
    return;
  }

  // POST /admin/api/key/regenerate
  if (req.method === 'POST' && pathname === '/admin/api/key/regenerate') {
    const newKey = cfgMod.generateApiKey();
    cfgMod.update({ apiKey: newKey });
    return json(res, 200, { ok: true, apiKey: newKey });
  }

  // POST /admin/api/settings {defaultModel, thinking, throttleMs, autoOpen, port}
  if (req.method === 'POST' && pathname === '/admin/api/settings') {
    const patch = {};
    if (typeof body.defaultModel === 'string' && body.defaultModel) patch.defaultModel = body.defaultModel;
    if (typeof body.thinking === 'boolean') patch.thinking = body.thinking;
    if (Number.isFinite(Number(body.throttleMs))) patch.throttleMs = Math.max(0, Math.min(30000, Number(body.throttleMs)));
    if (typeof body.autoOpen === 'boolean') patch.autoOpen = body.autoOpen;
    if (Number.isFinite(Number(body.port))) patch.port = Math.max(1, Math.min(65535, Number(body.port)));
    cfgMod.update(patch);
    return json(res, 200, { ok: true, message: '设置已保存' + (patch.port && patch.port !== cfg.port ? ' (端口修改需重启服务生效)' : ''), restart: !!patch.port && patch.port !== cfg.port });
  }

  // POST /admin/api/check (手动触发连通性检测)
  if (req.method === 'POST' && pathname === '/admin/api/check') {
    const fresh = cfgMod.load();
    if (!fresh.qwenToken) return json(res, 200, { ok: false, message: '未配置 token' });
    try {
      const models = await newClient(fresh).listModels();
      state.modelsCache = models;
      state.qwenOk = true;
      state.qwenCheckAt = Date.now();
      return json(res, 200, { ok: true, message: '连接正常 (' + models.length + ' 个模型)', models: models.map(m => m.id) });
    } catch (e) {
      state.qwenOk = false;
      state.qwenCheckAt = Date.now();
      return json(res, 200, { ok: false, message: e.message });
    }
  }

  return json(res, 404, { error: 'not found' });
}

// ---------------- 静态文件 ----------------
function serveStatic(res, file, type) {
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
    return true;
  } catch (e) { return false; }
}

// ---------------- 主处理器 ----------------
function createHandler(opts) {
  return async function handler(req, res) {
    const t0 = Date.now();
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    const cfg = cfgMod.load();
    cors(res, req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ---------- OpenAI 兼容端点 ----------
      if (pathname === '/v1/models' && req.method === 'GET') {
        state.reqCount++;
        if (!checkAuth(req, cfg)) {
          logReq(req.method, req.url, 401, Date.now() - t0);
          res.setHeader('WWW-Authenticate', 'Bearer');
          return json(res, 401, { error: { message: 'Invalid API key. 请使用管理页生成的密钥 (sk-qpp-...)', type: 'authentication_error', code: 'invalid_api_key' } });
        }
        const fresh = cfgMod.load();
        try {
          const models = await newClient(fresh).listModels();
          state.modelsCache = models;
          state.qwenOk = true;
          state.qwenCheckAt = Date.now();
          return json(res, 200, openaiModels(models));
        } catch (e) {
          // 拉取失败 -> 兜底静态列表 (仍可调用)
          if (e.code === 'AUTH_FAILED') {
            state.qwenOk = false;
            state.qwenCheckAt = Date.now();
            return json(res, e.status, { error: { message: e.message, type: 'authentication_error', code: e.code } });
          }
          return json(res, 200, openaiModels(FALLBACK_MODELS.map(m => ({ id: m.id, name: m.name }))));
        }
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        state.reqCount++;
        if (!checkAuth(req, cfg)) {
          logReq(req.method, req.url, 401, Date.now() - t0);
          return json(res, 401, { error: { message: 'Invalid API key. 请使用管理页生成的密钥 (sk-qpp-...)', type: 'authentication_error', code: 'invalid_api_key' } });
        }
        const body = await readBody(req, 20);
        if (body.stream === true) return streamChatCompletions(req, res, cfg, body);
        // 非流式
        const client = newClient(cfg);
        const t1 = Date.now();
        let result;
        try {
          const messages = Array.isArray(body.messages) ? body.messages : [];
          if (!messages.length) return json(res, 400, { error: { message: 'messages is required', type: 'invalid_request_error', code: 'bad_request' } });
          for (const m of messages) {
            if (Array.isArray(m.content)) m.content = m.content.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
            if (m.content == null) m.content = '';
            if (!['user', 'assistant', 'system', 'tool'].includes(m.role)) m.role = 'user';
          }
          result = await client.chatStream({
            model: (typeof body.model === 'string' && body.model) ? body.model : cfg.defaultModel,
            messages,
            thinking: body.thinking !== undefined ? body.thinking !== false : cfg.thinking !== false,
            onEvent: () => {}
          });
        } catch (e) {
          const err = normalizeError(e);
          logReq(req.method, req.url, err.status, Date.now() - t1, '[' + err.code + ']');
          return json(res, err.status, { error: { message: err.message, type: err.status === 401 ? 'authentication_error' : 'api_error', code: err.code } });
        }
        const msg = { role: 'assistant', content: result.answer };
        if (result.thinking) msg.reasoning_content = result.thinking;
        logReq(req.method, req.url, 200, Date.now() - t1, result.answer.length + 'ch');
        return json(res, 200, {
          id: 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24),
          object: 'chat.completion',
          created: nowSec(),
          model: result.model,
          system_fingerprint: 'qwen-studio-pp/' + VERSION,
          choices: [{ index: 0, message: msg, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: (result.usage && (result.usage.input_tokens || result.usage.prompt_tokens)) || 0,
            completion_tokens: (result.usage && (result.usage.output_tokens || result.usage.completion_tokens)) || 0,
            total_tokens: (result.usage && result.usage.total_tokens) || 0
          }
        });
      }

      // ---------- 管理端 ----------
      if (pathname.startsWith('/admin/')) {
        if (!adminHostOk(req)) {
          return json(res, 403, { error: 'admin 仅允许本机访问' });
        }
        if (req.method === 'POST') {
          const body = await readBody(req, 5);
          return handleAdmin(req, res, cfg, pathname, body);
        }
        return handleAdmin(req, res, cfg, pathname, {});
      }

      // ---------- 管理页 ----------
      if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
        if (serveStatic(res, path.join(opts.publicDir, 'admin.html'), 'text/html')) return;
        return json(res, 500, { error: 'admin.html missing' });
      }
      if (pathname === '/healthz') {
        return json(res, 200, { ok: true, version: VERSION });
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[server] internal error:', e);
      try { json(res, 500, { error: { message: 'internal error: ' + normalizeError(e).message, type: 'api_error', code: 'INTERNAL_ERROR' } }); } catch (e2) {}
    }
  };
}

function startServer(opts) {
  const handler = createHandler(opts);
  const server = http.createServer(handler);
  // 长流式连接保活
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0; // 流式响应可能超过默认 300s
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}

module.exports = { startServer, state };
