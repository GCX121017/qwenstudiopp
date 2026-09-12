#!/usr/bin/env node
// Qwen Studio++ CLI 入口
//   qspp            启动服务 (默认)
//   qspp doctor     仅环境自检
//   qspp key        重新生成 API 密钥
//   qspp token <t>  命令行直接保存 token
//   qspp --version
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const cfgMod = require(path.join(PKG_DIR, 'lib', 'config'));
const doctor = require(path.join(PKG_DIR, 'lib', 'doctor'));
const { startServer } = require(path.join(PKG_DIR, 'lib', 'server'));

const C = doctor.C;
const BANNER = `
${C.bold}  ██████╗ ██╗  ██╗██╗    ██╗███████╗███╗   ██╗${C.rst}
${C.bold} ██╔═══██╗██║ ██╔╝██║    ██║██╔════╝████╗  ██║${C.rst}
${C.bold} ██║   ██║█████╔╝ ██║ █╗ ██║█████╗  ██╔██╗ ██║${C.rst}
${C.bold} ██║▄▄ ██║██╔═██╗ ██║███╗██║██╔══╝  ██║╚██╗██║${C.rst}
${C.bold} ╚██████╔╝██║  ██╗╚███╔███╔╝███████╗██║ ╚████║${C.rst}
${C.bold}  ╚══▀▀═╝ ╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝╚═╝  ╚═══╝${C.rst}
${C.dim}   Qwen Studio++ v${cfgMod.VERSION}  本地 OpenAI 兼容网关${C.rst}
`;

function printHelp() {
  console.log(BANNER);
  console.log(`
用法:
  qspp                 启动服务并打开管理页
  qspp doctor          仅环境自检
  qspp key             重新生成 API 密钥
  qspp token <token>   命令行保存 Qwen token (也可在管理页操作)
  qspp --version       版本
  qspp --help          帮助

选项:
  --port <n>     服务端口 (默认 8818)
  --host <h>     监听地址 (默认 127.0.0.1, --lan 相当于 0.0.0.0)
  --lan          允许局域网设备访问
  --no-open      启动后不自动打开浏览器
`);
}

function parseArgs(argv) {
  const opts = { _: [], port: null, host: null, lan: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--lan') { opts.lan = true; opts.open = false; }
    else if (a === '--no-open') opts.open = false;
    else if (a === '--help' || a === '-h') opts._.push('help');
    else if (a === '--version' || a === '-v') opts._.push('version');
    else opts._.push(a);
  }
  return opts;
}

function openBrowser(url) {
  const plat = process.platform;
  try {
    if (plat === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (plat === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { /* 打不开就算了 */ }
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._[0];

  if (cmd === 'help') { printHelp(); return; }
  if (cmd === 'version') { console.log('qwen-studio-pp v' + cfgMod.VERSION); return; }

  const cfg = cfgMod.load();
  if (opts.port) cfg.port = opts.port;
  if (opts.host) cfg.host = opts.host;
  if (opts.lan) cfg.host = '0.0.0.0';

  // ---- 子命令 ----
  if (cmd === 'doctor') {
    console.log(BANNER);
    console.log('  环境自检:');
    const r = await doctor.runDoctor(cfgMod.load(), { pkgDir: PKG_DIR, checkPort: false });
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'key') {
    const newKey = cfgMod.generateApiKey();
    cfgMod.update({ apiKey: newKey });
    console.log('已重新生成 API 密钥:');
    console.log('  ' + newKey);
    console.log('\n请更新 Cherry Studio / zcode 等工具中保存的密钥。');
    return;
  }
  if (cmd === 'token') {
    const raw = opts._[1];
    if (!raw) {
      console.error('用法: qspp token <JWT或Cookie串>');
      process.exit(1);
    }
    const san = cfgMod.sanitizeQwenToken(raw);
    if (!san.ok) {
      console.error(san.message);
      process.exit(1);
    }
    cfgMod.update({ qwenToken: san.token });
    const extra = san.note ? ', ' + san.note : '';
    console.log('Token 已保存 (识别为 ' + san.type + extra + ')。');
    console.log('请重启服务或在管理页点击"检测连接"验证。');
    return;
  }
  if (cmd && cmd !== 'start') {
    console.error(`未知命令: ${cmd} (输入 qspp --help 查看用法)`);
    process.exit(1);
  }

  // ---- 默认: 启动服务 ----
  console.log(BANNER);
  console.log('  环境自检:');
  const dr = await doctor.runDoctor(cfg, { pkgDir: PKG_DIR, silent: true });
  for (const line of dr.lines) console.log(line);
  if (!dr.ok) {
    console.log('\n  环境自检未通过, 已退出。');
    process.exit(1);
  }

  cfgMod.save(cfg);
  const finalCfg = cfgMod.load();

  try {
    await startServer({
      port: finalCfg.port,
      host: finalCfg.host || '127.0.0.1',
      publicDir: path.join(PKG_DIR, 'public')
    });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  ${C.bad} 端口 ${finalCfg.port} 被占用。`);
      console.error(`     很可能是之前启动的服务还在运行 (旧窗口/旧版本)。`);
      console.error(`     处理: 关闭所有运行 qspp 的终端窗口, 或任务管理器结束 node.exe 进程, 再重新运行 qspp。`);
      console.error(`     或换端口启动: qspp --port ${Number(finalCfg.port) + 1}`);
      process.exit(1);
    }
    throw e;
  }

  const host = finalCfg.host || '127.0.0.1';
  const shown = (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host;
  const base = `http://${shown}:${finalCfg.port}`;
  const openUrl = base + '/';

  console.log(`
  ${C.ok} 服务已启动${C.rst}

  管理页面   ${C.bold}${openUrl}${C.rst}
  API 端点   ${C.bold}${base}/v1/chat/completions${C.rst}
             ${C.bold}${base}/v1/models${C.rst}
  API 密钥   ${finalCfg.apiKey.slice(0, 12)}${C.dim}...${C.rst}  (管理页可查看/重新生成)

  ${C.dim}Qwen token: ${finalCfg.qwenToken ? '已配置 ' + cfgMod.maskToken(finalCfg.qwenToken) : '未配置 — 打开管理页粘贴即可'}
  配置文件:   ${cfgMod.CONFIG_FILE}
  停止服务:   Ctrl + C${C.rst}
`);

  if (opts.open && finalCfg.autoOpen !== false) openBrowser(openUrl);

  // 首次运行提示 token 状态
  if (!finalCfg.qwenToken) {
    console.log(`  ${C.warn} 提示: 尚未配置 Qwen token, API 暂不可用。打开管理页按引导配置即可。`);
    console.log('');
  }

  const shutdown = (sig) => {
    console.log(`\n  收到 ${sig}, 服务已停止。再见!`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    console.error('\n[error]', e.message);
  });
  process.on('unhandledRejection', (e) => {
    console.error('\n[error]', (e && e.message) || e);
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
