const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SHOT = path.join(__dirname, 'verify-be8001');
try { fs.rmSync(SHOT, { recursive: true, force: true }); } catch {}
fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(url, timeout = 90000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(url).then(resolve).catch(() => {
        if (Date.now() - t0 > timeout) reject(new Error('timeout ' + url));
        else setTimeout(poll, 500);
      });
    })();
  });
}

(async () => {
  const out = {};
  const be = spawn(path.join(ROOT, 'backend', '.venv', 'Scripts', 'python.exe'),
    ['-m', 'uvicorn', 'main:app', '--port', '8001'],
    { cwd: path.join(ROOT, 'backend') });
  const fe = spawn(process.execPath,
    [path.join(ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5174', '--strictPort'],
    { cwd: path.join(ROOT, 'frontend'),
      env: { ...process.env, VITE_API_URL: 'http://localhost:8001' } });
  try {
    await waitFor('http://localhost:8001/health');
    await waitFor('http://localhost:5174/');
    // 1) /trend from the graded-path backend on 8001: timing + payload.
    const t0 = Date.now();
    const r1 = await fetch('http://localhost:8001/trend?bbox=-54.0,-2.3,-53.0,-1.3');
    const b1 = await r1.json();
    out.firstMs = Date.now() - t0;
    const t2 = Date.now();
    const r2 = await fetch('http://localhost:8001/trend?bbox=-54.0,-2.3,-53.0,-1.3');
    await r2.json();
    out.secondMs = Date.now() - t2;
    out.status = r1.status;
    out.yearRange = b1.year_range;
    out.years = [...new Set(b1.daily.map((d) => d.date.slice(0, 4)))].sort();
    out.daily = b1.daily.length;
    out.season2025 = Math.round(b1.daily.filter((d) => d.date.startsWith('2025-')).reduce((a, d) => a + d.fire_days, 0));

    // 2) Uninterrupted headless pass on the Trend view (user's :5173).
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['--no-sandbox', '--window-size=1280,900', '--user-data-dir=' + path.join(SHOT, 'profile')],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('http://localhost:5174/', { waitUntil: 'networkidle0', timeout: 90000 });
    console.error('STEP goto-ok');
    await page.waitForSelector('.trend-body', { timeout: 60000 });
    console.error('STEP trend-body-ok');
    const derrs = [];
    page.on('pageerror', (e) => derrs.push('PAGEERROR: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') derrs.push('CONSOLE: ' + m.text().slice(0, 250)); });
    try {
      await page.waitForFunction(
        () => { const t = document.querySelector('.cal-scroll .cal'); return t && t.children.length > 300; },
        { timeout: 60000 },
      );
    } catch (e) {
      out.diag = await page.evaluate(() => ({
        body: document.body.innerText.slice(0, 500),
        calCells: document.querySelectorAll('.cal-scroll .cal i').length,
        apiBase: document.body.innerHTML.includes('8001') ? 'mentions-8001' : 'no-8001-ref',
      }));
      out.diagErrors = [...new Set(derrs)].slice(0, 8);
      throw e;
    }
    async function chip(label) {
      await page.evaluate((lb) => {
        [...document.querySelectorAll('.loc-chip')].find((b) => b.textContent.includes(lb)).click();
      }, label);
    }
    console.error('STEP cal-ok, clicking Red Hill');
    await chip('Red Hill');
    await page.waitForFunction(
      () => document.querySelector('.map-chip')?.textContent.includes('RED HILL'),
      { timeout: 120000 },
    );
    console.error('STEP redhill-ok');
    const tClick = Date.now();
    await chip('Prainha');
    const frames = [];
    await page.screenshot({ path: path.join(SHOT, 'g0-click.png') });
    frames.push('g0-click.png');
    let sawLoading = false;
    for (let i = 0; i < 60; i++) {
      const s = await page.evaluate(() => ({
        body: document.body.innerText,
        chip: document.querySelector('.map-chip')?.textContent || '',
      }));
      if (s.body.includes('Loading the archive')) {
        sawLoading = true;
        await page.screenshot({ path: path.join(SHOT, 'g1-loading.png') });
        frames.push('g1-loading.png');
        break;
      }
      if (s.chip.includes('PRAINHA')) break;
      await sleep(100);
    }
    out.sawLoadingBanner = sawLoading;
    await page.waitForFunction(
      () => document.querySelector('.map-chip')?.textContent.includes('PRAINHA'),
      { timeout: 120000 },
    );
    out.applyMs = Date.now() - tClick;
    out.mapChip = await page.evaluate(() => document.querySelector('.map-chip')?.textContent);
    out.mapNote = await page.evaluate(() => document.querySelector('.trend-map-meta')?.innerText.slice(0, 200));
    await sleep(500);
    await page.screenshot({ path: path.join(SHOT, 'g2-loaded.png') });
    frames.push('g2-loaded.png');
    out.frames = frames;
    out.banner = await page.evaluate(() => document.querySelector('.trend-banner')?.innerText.slice(0, 220));
    out.yearBtns = await page.evaluate(() => [...document.querySelectorAll('.year-btn')].map((b) => b.textContent));
    out.jsErrors = [...new Set(errs)].slice(0, 5);
    out.ok = true;
    await browser.close();
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
  } finally {
    be.kill();
    try { fe.kill(); } catch {}
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('FATAL ' + e); process.exit(1); });
