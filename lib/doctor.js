// Qwen Studio++ - 环境自检 doctor
// 启动前自动检查: Node 版本 / 缺失依赖自动安装 / 配置目录 / 端口占用
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const cfgMod = require('./config');

const C = { ok: '\x1b[32m✓\x1b[0m', bad: '\x1b[31m✗\x1b[0m', warn: '\x1b[33m!\x1b[0m', dim: '\x1b[2m', rst: '\x1b[0m', bold: '\x1b[1m' };

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return { ok: major >= 18, major, detail: process.versions.node };
}

// 检查 package.json 声明的依赖是否缺失, 缺失则自动 npm install
// (本工具核心零依赖, 此逻辑覆盖"源码扩展依赖"场景: 只要声明了依赖且未安装就自动装)
function checkAndInstallDeps(pkgDir, log) {
  const result = { needed: false, installed: false, error: null };
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch (e) { return result; }
  const deps = Object.keys(pkg.dependencies || {});
  if (!deps.length) return result; // 零依赖, 直接通过
  const missing = deps.filter(d => {
    try { require.resolve(d, { paths: [pkgDir] }); return false; } catch (e) { return true; }
  });
  if (!missing.length) return result;
  result.needed = true;
  log(`检测到缺失依赖: ${missing.join(', ')}`);
  log('正在自动安装 (npm install --omit=dev)...');
  const isWin = process.platform === 'win32';
  const npmCmd = isWin ? 'npm.cmd' : 'npm';
  const r = spawnSync(npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: pkgDir, stdio: 'inherit', shell: isWin
  });
  if (r.error || r.status !== 0) {
    result.error = r.error ? r.error.message : ('npm exit ' + r.status);
  } else {
    result.installed = true;
  }
  return result;
}

// 端口可用性检测
function checkPort(port, host) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host || '0.0.0.0');
  });
}

// 找一个可用端口 (从 startPort 开始向上找)
async function findFreePort(startPort, host) {
  for (let p = startPort; p < startPort + 50; p++) {
    if (await checkPort(p, host)) return p;
  }
  return 0;
}

async function runDoctor(cfg, opts) {
  const lines = [];
  const log = (s) => { lines.push(s); if (!opts || !opts.silent) console.log(s); };

  // 1. Node 版本
  const node = checkNode();
  if (node.ok) {
    log(`  ${C.ok} Node.js 版本 ${node.detail}`);
  } else {
    log(`  ${C.bad} Node.js 版本过低 (${node.detail}), 需要 >= 18`);
    log(`      请到 https://nodejs.org 下载安装 LTS 版本后重试`);
    return { ok: false, lines };
  }

  // 2. 依赖检查 + 自动安装
  const deps = checkAndInstallDeps(opts.pkgDir, (s) => log(`  ${C.dim}${s}${C.rst}`));
  if (deps.error) {
    log(`  ${C.bad} 依赖自动安装失败: ${deps.error}`);
    return { ok: false, lines };
  }
  if (deps.needed && deps.installed) log(`  ${C.ok} 缺失依赖已自动安装`);
  else if (!deps.needed) log(`  ${C.ok} 运行依赖完整 (零依赖设计)`);

  // 3. 配置目录
  try {
    fs.accessSync(cfgMod.CONFIG_DIR);
    log(`  ${C.ok} 配置目录 ${cfgMod.CONFIG_DIR}`);
  } catch (e) {
    try {
      const os = require('os');
      fs.mkdirSync(cfgMod.CONFIG_DIR, { recursive: true });
      log(`  ${C.ok} 已创建配置目录 ${cfgMod.CONFIG_DIR}`);
    } catch (e2) {
      log(`  ${C.bad} 配置目录不可写: ${cfgMod.CONFIG_DIR}`);
      return { ok: false, lines };
    }
  }

  // 4. 端口
  if (opts.checkPort !== false) {
    const free = await checkPort(cfg.port, cfg.host);
    if (free) {
      log(`  ${C.ok} 端口 ${cfg.port} 可用`);
    } else {
      const alt = await findFreePort(Number(cfg.port) + 1, cfg.host);
      if (alt) {
        log(`  ${C.warn} 端口 ${cfg.port} 被占用, 本次自动改用 ${alt} (可用 qspp --port 端口 固定)`);
        cfg.port = alt;
      } else {
        log(`  ${C.bad} 端口 ${cfg.port} 被占用且找不到可用端口`);
        return { ok: false, lines };
      }
    }
  }

  // 5. Qwen token
  if (cfg.qwenToken) {
    log(`  ${C.ok} Qwen token 已配置 (${cfgMod.maskToken(cfg.qwenToken)})`);
  } else {
    log(`  ${C.warn} Qwen token 未配置 — 启动后在管理页粘贴即可, 不影响服务启动`);
  }

  return { ok: true, lines };
}

module.exports = { runDoctor, checkNode, checkPort, findFreePort, checkAndInstallDeps, C };
