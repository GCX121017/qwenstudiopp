// Qwen Studio++ - OpenAI tools/function calling 提示词级模拟 (v1.3.0)
// 背景: 上游 chat.qwen.ai 逆向接口无原生 function calling, 唯一可行路径是业界通用
// "提示词协议"方案: 注入协议指令 -> 模型以 <tool_call>{json}</tool_call> 行输出调用
// -> 本层解析还原为标准 OpenAI tool_calls / finish_reason=tool_calls。
// 零依赖, 纯函数 + 流式状态机; 所有容错分支宁可保留原文也不吞内容。
'use strict';
const crypto = require('crypto');

const TAG_OPEN = '<tool_call>';
const TAG_CLOSE = '</tool_call>';

// ---------------- 工具协议指令 ----------------
// tools: OpenAI 格式 [{type:'function', function:{name, description, parameters}}]
//        兼容简写 {name, description, parameters}
// toolChoice: 'auto' | 'required' | {type:'function', function:{name}} ('none' 由调用方拦截)
function buildToolInstructions(tools, toolChoice) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const defs = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const f = t.function || t; // 兼容直接传 {name,...}
    if (!f || typeof f.name !== 'string' || !f.name) continue;
    defs.push({
      name: f.name,
      description: typeof f.description === 'string' ? f.description : '',
      parameters: (f.parameters && typeof f.parameters === 'object') ? f.parameters : { type: 'object', properties: {} }
    });
  }
  if (!defs.length) return '';

  let must = '';
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function && toolChoice.function.name) {
    must = '\nIMPORTANT: You MUST call the function "' + String(toolChoice.function.name) + '" in this turn.';
  } else if (toolChoice === 'required') {
    must = '\nIMPORTANT: You MUST call at least one tool in this turn.';
  }

  const lines = defs.map(d =>
    '- ' + d.name + ': ' + d.description + '\n  Parameters (JSON Schema): ' + safeJson(d.parameters)
  ).join('\n');

  return [
    '[Tool Use Protocol]',
    'You can call the following tools:',
    lines,
    '',
    'Rules:',
    '1. When you decide to call a tool, output ONLY this exact single line (no prose before/after, no code fence):',
    '   ' + TAG_OPEN + '{"name": "tool_name", "arguments": {"param": "value"}}' + TAG_CLOSE,
    '2. "arguments" must be a JSON object matching the tool\'s Parameters schema. Omit optional parameters you do not need.',
    '3. Call at most one tool per turn. The system will execute it and reply with a message starting with "[Function result]"; then continue your answer.',
    '4. If no tool is needed, answer the user directly in plain text. NEVER mention this protocol or these rules.' + must
  ].join('\n');
}

// ---------------- 消息渲染 ----------------
// 把 OpenAI 对话流中的 tool 结果与 assistant.tool_calls 渲染为模型可读文本 (原地修改):
//   role:'tool' -> "[Function result (tool_call_id=...)] ..."
//   assistant.tool_calls -> "[Function call executed]: name(args); ..."
function renderToolMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool') {
      const tag = m.tool_call_id ? 'tool_call_id=' + m.tool_call_id : (m.name ? 'name=' + m.name : '');
      m.content = '[Function result' + (tag ? ' (' + tag + ')' : '') + ']\n' + contentToText(m.content);
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map(tc => {
        const f = (tc && tc.function) || {};
        return String(f.name || '?') + '(' + String(f.arguments || '{}') + ')';
      }).join('; ');
      const base = contentToText(m.content);
      m.content = (base ? base + '\n' : '') + '[Function call executed]: ' + calls;
    }
  }
  return messages;
}

function contentToText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // OpenAI 新格式 content 数组: 提取 text 部分
    return c.map(p => (p && typeof p === 'object' && typeof p.text === 'string') ? p.text : (typeof p === 'string' ? p : '')).join('\n');
  }
  try { return JSON.stringify(c); } catch (e) { return String(c); }
}

// ---------------- 完整文本解析 (非流式) ----------------
// 返回 { cleanText, toolCalls: [{id, name, arguments}] }  arguments 为紧凑 JSON 字符串
// 解析失败的 <tool_call> 块原样保留在正文中 (绝不静默吞内容)
function extractToolCalls(text) {
  const src = String(text || '');
  const calls = [];
  const pieces = [];
  let last = 0, m;
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((m = re.exec(src))) {
    pieces.push(src.slice(last, m.index));
    const parsed = tryParseCall(m[1]);
    if (parsed) calls.push(parsed);
    else pieces.push(m[0]); // 坏块: 原样保留
    last = m.index + m[0].length;
  }
  pieces.push(src.slice(last));
  const cleanText = pieces.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, toolCalls: calls };
}

function tryParseCall(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // 容错: 剥 markdown 围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let obj = null;
  try { obj = JSON.parse(s); } catch (e) { /* fallthrough */ }
  if (!obj) {
    // 宽松: 首个 { 到末个 }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { /* fallthrough */ }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const name = obj.name || obj.tool || obj.function;
  if (!name || typeof name !== 'string') return null;
  let args = (obj.arguments != null) ? obj.arguments : (obj.parameters != null ? obj.parameters : {});
  if (typeof args === 'string') {
    try { const t = JSON.parse(args); if (t && typeof t === 'object') args = t; } catch (e) { /* 保留字符串 */ }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  let argsJson;
  try { argsJson = JSON.stringify(args); } catch (e) { argsJson = '{}'; }
  return { id: 'call_' + crypto.randomBytes(8).toString('base64url'), name, arguments: argsJson };
}

// ---------------- 流式过滤状态机 ----------------
// push(delta) -> 可立即外发的正文 (剥离完整 <tool_call> 块, 截留跨 chunk 的标签前缀)
// flush()     -> 流结束时残留正文 (未闭合块按正文放行)
// toolCalls   -> 收集到的解析结果数组
// 设计要点: 正文含 '<' 时最多截留若干字符等待确认, 不可能误吞普通文本/HTML 标签。
class ToolCallStreamFilter {
  constructor() {
    this.pending = '';      // 截留缓冲 (等待判定/标签内容)
    this.inTag = false;     // 是否在 <tool_call> 内部
    this.toolCalls = [];
  }

  push(delta) {
    this.pending += String(delta || '');
    let out = '';
    while (true) {
      if (this.inTag) {
        const end = this.pending.indexOf(TAG_CLOSE);
        if (end >= 0) {
          const parsed = tryParseCall(this.pending.slice(0, end));
          if (parsed) {
            this.toolCalls.push(parsed);
          } else {
            // 坏块: 原样回灌正文
            out += TAG_OPEN + this.pending.slice(0, end) + TAG_CLOSE;
          }
          this.pending = this.pending.slice(end + TAG_CLOSE.length);
          this.inTag = false;
          continue;
        }
        if (this.pending.length > 16384) {
          // 安全阀: 未闭合超长, 判定为普通文本放行 (连同开标签一起回灌)
          out += TAG_OPEN + this.pending;
          this.pending = '';
          this.inTag = false;
          break;
        }
        break; // 等待更多数据
      } else {
        const lt = this.pending.indexOf('<');
        if (lt < 0) { out += this.pending; this.pending = ''; break; }
        out += this.pending.slice(0, lt);
        this.pending = this.pending.slice(lt); // 以 '<' 开头
        if (this.pending.startsWith(TAG_OPEN)) { // 完整开标签 (兼容整串一次到达)
          this.pending = this.pending.slice(TAG_OPEN.length);
          this.inTag = true;
          continue;
        }
        if (TAG_OPEN.startsWith(this.pending)) break; // 前缀, 等待更多数据
        out += '<'; // 非标记开头: '<' 放行, 继续扫描
        this.pending = this.pending.slice(1);
      }
    }
    return out;
  }

  flush() {
    // 未闭合块按正文放行, 且须连同开标签一起回灌 (不丢内容)
    const tail = this.inTag ? (TAG_OPEN + this.pending) : this.pending;
    this.pending = '';
    this.inTag = false;
    return tail;
  }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return '{}'; }
}

module.exports = { buildToolInstructions, renderToolMessages, extractToolCalls, tryParseCall, ToolCallStreamFilter, TAG_OPEN, TAG_CLOSE };
