const puppeteer = require('puppeteer-core');
const path = require('path');
const SHOT = path.join(__dirname, 'verify-final2');
try { require('fs').rmSync(SHOT, { recursive: true, force: true }); } catch {}
require('fs').mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { spawn } = require('child_process');
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
  const out = { live: { dates: {}, bad: [] }, trend: {} };
  const ROOT = path.resolve(__dirname, '..');
  const be = spawn(path.join(ROOT, 'backend', '.venv', 'Scripts', 'python.exe'),
    ['-m', 'uvicorn', 'main:app', '--port', '8000'],
    { cwd: path.join(ROOT, 'backend') });
  const fe = spawn(process.execPath,
    [path.join(ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort'],
    { cwd: path.join(ROOT, 'frontend') });
  try {
    await waitFor('http://localhost:8000/health');
    await waitFor('http://localhost:5173/');
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['--no-sandbox', '--user-data-dir=' + path.join(SHOT, 'profile')],
    });
    // ---- LIVE ----
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      page.on('response', (res) => {
        const u = res.url();
        if (u.includes('gibs.earthdata.nasa.gov')) {
          const m = u.match(/default\/(\d{4}-\d{2}-\d{2})/);
          if (m) out.live.dates[m[1]] = (out.live.dates[m[1]] || 0) + 1;
          if (res.status() >= 400) out.live.bad.push(res.status() + ' ' + u.slice(0, 120));
        }
      });
      page.on('pageerror', (e) => out.live.bad.push('PAGEERROR: ' + e.message));
      await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 90000 });
      await page.evaluate(() => [...document.querySelectorAll('.mode-switch button')].find((b) => b.textContent === 'Live').click());
      await sleep(12000);
      out.live.mapChip = true;
      out.live.wind = await page.evaluate(() => {
        const c = document.querySelector('.wind-chip');
        const r = c?.getBoundingClientRect();
        return { text: c?.textContent, right: r ? Math.round(r.right) : null, vw: window.innerWidth };
      });
      out.live.fresh = await page.evaluate(() => document.querySelector('.freshness')?.textContent);
      await page.screenshot({ path: path.join(SHOT, 'live-final.png') });
      // overlays off -> base map check
      await page.evaluate(() => [...document.querySelectorAll('.tgl')].find((b) => b.textContent.includes('True color')).click());
      await sleep(4000);
      await page.screenshot({ path: path.join(SHOT, 'live-baseonly.png') });
      await page.close();
    }
    // ---- TREND ----
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 90000 });
      await page.evaluate(() => [...document.querySelectorAll('.mode-switch button')].find((b) => b.textContent === 'Trend').click());
      await page.waitForSelector('.trend-body', { timeout: 60000 });
      await page.waitForFunction(
        () => { const t = document.querySelector('.cal-scroll .cal'); return t && t.children.length > 300; },
        { timeout: 120000 },
      );
      await page.evaluate(() => {
        const input = document.querySelector('input[aria-label="Trend area bbox"]');
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        native.call(input, '-54.0,-2.3,-53.0,-1.3');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await sleep(300);
      const tClick = Date.now();
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Apply area').click());
      await page.screenshot({ path: path.join(SHOT, 't0-click.png') });
      let saw = false;
      for (let i = 0; i < 60; i++) {
        const s = await page.evaluate(() => ({
          body: document.body.innerText,
          chip: document.querySelector('.map-chip')?.textContent || '',
        }));
        if (s.body.includes('Loading the archive')) {
          saw = true;
          await page.screenshot({ path: path.join(SHOT, 't1-loading.png') });
          break;
        }
        if (s.chip.includes('PRAINHA')) break;
        await sleep(100);
      }
      out.trend.sawLoadingBanner = saw;
      await page.waitForFunction(
        () => document.querySelector('.map-chip')?.textContent.includes('PRAINHA'),
        { timeout: 120000 },
      );
      out.trend.applyMs = Date.now() - tClick;
      out.trend.banner = await page.evaluate(() => document.querySelector('.trend-banner')?.innerText.slice(0, 120));
      out.trend.years = await page.evaluate(() => [...document.querySelectorAll('.year-btn')].map((b) => b.textContent));
      out.trend.stat = await page.evaluate(() => document.querySelector('.statgrid .hz-kpi, .statgrid .stat b')?.textContent);
      out.trend.jsErrors = [...new Set(errs)].slice(0, 5);
      await page.screenshot({ path: path.join(SHOT, 't2-loaded.png') });
      await page.close();
    }
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
