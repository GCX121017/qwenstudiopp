// Qwen Studio++ - 配置管理
// 配置文件位置: ~/.qwen-studio-pp/config.json
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_DIR = path.join(os.homedir(), '.qwen-studio-pp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const VERSION = require('../package.json').version;

const DEFAULTS = {
  port: 8818,
  host: '127.0.0.1',          // 127.0.0.1 仅本机; 0.0.0.0 允许局域网
  apiKey: '',                  // sk-qpp-xxx, 首次启动自动生成
  qwenToken: '',               // Qwen Studio JWT (localStorage token) 或整段 Cookie
  defaultModel: 'qwen3.8-max',
  thinking: true,              // 默认开启思考(摘要)
  throttleMs: 3200,            // 对 Qwen 的最小请求间隔 (防 Baxia 风控)
  autoOpen: true               // 启动后自动打开管理页
};

let cache = null;

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function generateApiKey() {
  return 'sk-qpp-' + crypto.randomBytes(24).toString('base64url');
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    process.stderr.write('[config] 配置文件损坏, 使用默认配置: ' + e.message + '\n');
    stored = {};
  }
  cache = Object.assign({}, DEFAULTS, stored);
  if (!cache.apiKey) {
    cache.apiKey = generateApiKey();
    save(cache);
  }
  return cache;
}

function save(cfg) {
  ensureDir();
  cache = cfg;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (e) { /* windows 忽略 */ }
  return cfg;
}

function update(patch) {
  const cfg = load();
  return save(Object.assign({}, cfg, patch));
}

function maskToken(token) {
  if (!token) return '';
  const t = String(token);
  if (t.length <= 12) return t.slice(0, 4) + '****';
  return t.slice(0, 10) + '****' + t.slice(-6);
}

// 清洗并校验用户粘贴的 token
// 背景: 用户常把 token 连同中文说明/引号/标签一起粘贴, 而 HTTP 头只允许 Latin-1 字符,
//      含中文会让 fetch 抛 "Cannot convert argument to a ByteString" (v1.1.1 用户实测)
// 返回: { ok:true, token, type, note } 或 { ok:false, message }
function sanitizeQwenToken(raw) {
  let s = String(raw == null ? '' : raw);
  // 去 BOM / 零宽字符 / 首尾空白
  s = s.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim();
  if (!s) return { ok: false, message: 'token 不能为空' };

  // 去掉成对包裹的引号 (直引号/中文弯引号)
  s = s.replace(/["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();

  // 1) 优先: 从任意混杂文本中提取 JWT 本体 (eyJ 开头三段式, 粘贴时带了标签/说明也能救回)
  const jwt = s.match(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/);
  if (jwt) {
    return { ok: true, token: jwt[0], type: 'jwt', note: jwt[0] === s ? '' : '已自动从粘贴内容中提取 token 本体' };
  }

  // 2) 无 JWT 结构: 先逐字符校验 (HTTP 头只能 Latin-1), 给出精确位置报错
  //    必须在 token= 提取之前做, 否则可能把含中文的"伪值"当成 token 提取走
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xFF) {
      return { ok: false, message:
        '粘贴内容第 ' + (i + 1) + ' 个字符是中文或特殊字符 "' + s[i] + '"，HTTP 请求头不允许。' +
        '请只复制 token 本体：打开 chat.qwen.ai → F12 → Console 输入 localStorage.token 回车，' +
        '复制输出的 eyJ 开头字符串（不要带中文说明或引号）。' };
    }
  }
  if (/[\x00-\x1F\x7F]/.test(s)) {
    return { ok: false, message: 'token 含换行或控制字符，请确认复制完整且仅为一行' };
  }

  // 3) Cookie 串里非 JWT 的 token= 值 (已确保为纯拉丁字符)
  const cm = s.match(/(?:^|;)\s*token\s*=\s*([^;]+)/);
  if (cm && cm[1].trim()) {
    const v = cm[1].trim();
    return { ok: true, token: v, type: detectTokenType(v), note: '已从 Cookie 串中提取 token 值' };
  }
  // 4) 兜底: 既非 JWT 结构、也非 Cookie 串的裸字符串
  //    实测 chat.qwen.ai 模型列表端点对"带了但无效"的 token 仍返回 200 (v1.1.6 确认),
  //    上游验证不了, 必须在本地拦住明显不是凭证的内容, 避免粘错后误报"验证通过",
  //    直到用户真正发起对话才 401, 又要多轮排查
  const type = detectTokenType(s);
  if (type === 'unknown') {
    return { ok: false, message:
      '粘贴内容看起来不是 Qwen Token（既不是 eyJ 开头的 JWT，也不是 Cookie 串）。' +
      '获取方式：浏览器登录 chat.qwen.ai → F12 → Console 输入 localStorage.token 回车，' +
      '复制输出的 eyJ 开头字符串；或复制请求头里完整的 cookie 值。' };
  }
  return { ok: true, token: s, type, note: '' };
}

// 识别 token 类型
// - JWT: eyJ 开头 (localStorage.token / cookie token)
// - Cookie: 含 "=" 且不含空格换行过多, 或以 "token=..." 开头的整段 Cookie
function detectTokenType(token) {
  const t = String(token || '').trim();
  if (!t) return 'empty';
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(t)) return 'jwt';
  if (t.includes('=') && t.includes(';')) return 'cookie';
  if (t.length > 100) return 'jwt'; // 可能去掉换行的 JWT
  return 'unknown';
}

module.exports = {
  CONFIG_DIR, CONFIG_FILE, VERSION, DEFAULTS,
  load, save, update, generateApiKey, maskToken, detectTokenType, sanitizeQwenToken
};
