/**
 * 集成测试：用真实 Chrome + playwright-core 打开模拟学习页，驱动脚本跑完整流程。
 *
 * 运行：
 *   node test/test.cjs normal   # 正常流程（视频 → 图文 → 视频 + 弹题）
 *   node test/test.cjs skip     # 跳过已完成章节
 *   node test/test.cjs novue    # 站点 Vue 实例不可用时的 DOM 兜底
 *
 * 依赖 playwright-core 与任意 Chromium 内核浏览器：
 *   PW_CORE      playwright-core 的 require 路径（默认找 OCS Desktop 自带的）
 *   CHROME_PATH  浏览器可执行文件（默认找 OCS Desktop 自带的 Chrome for Testing）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'zjooc-auto.user.js');
const MOCK = path.join(__dirname, 'mock.html');

function loadPlaywright() {
  const candidates = [
    process.env.PW_CORE,
    'playwright-core',
    'C:\\Users\\Administrator\\AppData\\Local\\Programs\\OCS Desktop\\resources\\app\\node_modules\\playwright-core'
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* next */ }
  }
  throw new Error('找不到 playwright-core，请设置环境变量 PW_CORE');
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Users\\Administrator\\AppData\\Local\\Programs\\OCS Desktop\\resources\\bin\\chrome\\chrome\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到浏览器，请设置环境变量 CHROME_PATH');
}

const { chromium } = loadPlaywright();
const DOM = fs.readFileSync(MOCK, 'utf8');
const CODE = fs.readFileSync(SCRIPT, 'utf8');
const PAGE_PATH = '/ucenter/student/course/study/9/plan/detail/111';

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/ucenter/') || req.url.startsWith('/mock')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DOM);
    return;
  }
  res.writeHead(404);
  res.end('nf');
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const mode = process.argv[2] || 'normal';
  const qs = mode === 'skip' ? '?skip111=1' : mode === 'novue' ? '?novue=1' : '';
  await page.goto('http://127.0.0.1:' + port + PAGE_PATH + qs);

  await page.evaluate(() => {
    localStorage.setItem('zjooc_auto_settings_v1', JSON.stringify({
      autoStart: true, rate: 2, mute: true, autoNext: true, skipDone: true,
      autoAnswer: true, background: false, docWait: 2
    }));
  });
  await page.addScriptTag({ content: CODE });

  let result;
  try {
    await page.waitForFunction(
      () => window.__ZJOOC_AUTO__ && window.__ZJOOC_AUTO__.state.phase === 'FINISHED',
      null, { timeout: 90000 }
    );
    result = await page.evaluate(() => ({
      phase: window.__ZJOOC_AUTO__.state.phase,
      status: window.__ZJOOC_AUTO__.state.status,
      nav: window.__MOCK__.nav,
      answers: window.__MOCK__.answers,
      finishText: window.__MOCK__.finishText,
      speeds: window.__MOCK__.speeds,
      muted: window.__MOCK__.muted,
      doneIds: Object.keys(window.__ZJOOC_AUTO__.state.doneIds)
    }));
    console.log('MODE=' + mode);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.phase === 'FINISHED' ? 0 : 1;
  } catch (e) {
    const snap = await page.evaluate(() => ({
      phase: window.__ZJOOC_AUTO__ && window.__ZJOOC_AUTO__.state.phase,
      status: window.__ZJOOC_AUTO__ && window.__ZJOOC_AUTO__.state.status,
      nav: window.__MOCK__ && window.__MOCK__.nav,
      answers: window.__MOCK__ && window.__MOCK__.answers
    }));
    console.log('TIMEOUT/FAIL:', e.message);
    console.log(JSON.stringify(snap, null, 2));
    process.exitCode = 1;
  }
  if (errors.length) console.log('PAGE ERRORS:', JSON.stringify(errors.slice(0, 5)));
  await browser.close();
  server.close();
})().catch((e) => {
  console.error('FATAL', e);
  server.close();
  process.exit(1);
});
