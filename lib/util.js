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

module.exports = { QwenError, safeStr, sleep, sseWrite, json, readBody, nowSec, uuid };
