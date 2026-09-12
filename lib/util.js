// Qwen Studio++ - 通用工具
'use strict';

// 任意值安全转字符串: 对象 -> JSON 文本(截断), 根治 "[object Object]" 丢失诊断信息
// (错误 details 常是嵌套对象, 直接字符串拼接会变成 [object Object], 远程无法排查)
function safeStr(v, limit) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    let s = JSON.stringify(v);
    if (s === undefined) return String(v);
    if (s.length > (limit || 400)) s = s.slice(0, limit || 400) + '...(已截断)';
    return s;
  } catch (e) {
    return '[无法序列化: ' + ((e && e.message) || 'unknown') + ']';
  }
}

// 错误对象归一化 (v1.1.8): 保证 code/message/status 全为基本类型且非空
// 背景: 若 e.message 为 undefined, JSON.stringify 会直接丢掉该键, 客户端(如 Cherry Studio)
// 拿到缺字段的 error 对象后自行拼接, 会显示 "null: [object Object]" 之类的失真报错
function normalizeError(e) {
  const isQ = e instanceof QwenError;
  const code = isQ ? e.code : (e && typeof e.code === 'string' && e.code ? e.code : 'UPSTREAM_ERROR');
  let message;
  if (e && typeof e.message === 'string' && e.message) message = e.message;
  else {
    // message 为空 -> 回退 e.cause; cause 常是 Error 实例(JSON.stringify 丢 message, 必须特判取 .message)
    const c = e && e.cause;
    if (c && typeof c.message === 'string' && c.message) message = (c.code ? c.code + ' ' : '') + c.message;
    else message = (e ? safeStr(c || e, 400) : '') || '未知错误';
  }
  let status = isQ ? (e.status || 502) : ((e && Number(e.status)) || 502);
  if (!Number.isFinite(status) || status < 400 || status > 599) status = 502;
  return { code: String(code || 'UPSTREAM_ERROR'), message: String(message), status };
}

class QwenError extends Error {
  constructor(code, message, status) {
    super(safeStr(message));   // 消息强制字符串化, 传对象也不会再变 [object Object]
    this.name = 'QwenError';
    this.code = code;       // e.g. AUTH_FAILED / CHAT_NOT_FOUND / BAD_REQUEST / NETWORK
    this.status = status || 502; // 映射给 OpenAI 客户端的 HTTP 状态
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 简单事件流输出器 (SSE 格式)
function sseWrite(res, event, data) {
  res.write('data: ' + JSON.stringify(Object.assign({ _e: event }, data)) + '\n\n');
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// 读取请求体 (限制大小)
function readBody(req, limitMB) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const limit = (limitMB || 10) * 1024 * 1024;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function uuid() { return require('crypto').randomUUID(); }

module.exports = { QwenError, safeStr, normalizeError, sleep, sseWrite, json, readBody, nowSec, uuid };
