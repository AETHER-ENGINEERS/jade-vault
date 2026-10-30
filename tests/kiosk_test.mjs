// Kiosk mode switch (Config → App → Background) against a fake Android shell, and hidden in a browser.
import pw from 'playwright';
import fs from 'node:fs';
const { chromium } = pw;
const URL_ = process.argv[2] || 'file://' + process.env.JV_WEB;
const css = fs.readFileSync('tw.css', 'utf8');
const log = [], fail = []; const ok = (c, m) => (c ? log : fail).push((c ? 'PASS ' : 'FAIL ') + m);
const browser = await chromium.launch();
async function open(android) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(android => {
    if (!localStorage.getItem('jvault:settings')) localStorage.setItem('jvault:settings', JSON.stringify({ model: 'qwen3:8b', journalOn: false }));
    if (!android) return;
    window.__kiosk = []; window.__k = { on: false, home: false, locked: false, pinned: false, owner: false };
    window.NetrunnerAndroid = {
      kioskStatus() { return JSON.stringify(window.__k); },
      setKiosk(on) { window.__kiosk.push(on); Object.assign(window.__k, { on, home: on, pinned: on, locked: false }); },
      apiConfigure() { return '{}'; }, apiStatus() { return '{}'; }, apiResult() {},
      keepAlive() { return true; }, batteryOptimized() { return false; }, requestNotifications() {}, openBatterySettings() {},
      ttsAvailable() { return false; }, speak() { return false; }, stop() {}, notify() {}, saveFile() {}, openTtsSettings() {},
    };
  }, android);
  const page = await ctx.newPage();
  page.on('pageerror', e => fail.push('[pageerror] ' + e.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (url.startsWith('https://cdn.tailwindcss.com/')) return route.fulfill({ contentType: 'text/javascript', body: `window.tailwind={};(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.prepend(s);})();` });
    if (url.includes('marked.min.js')) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(process.env.JV_NM + 'marked/lib/marked.umd.js', 'utf8') });
    if (url.includes('purify.min.js')) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(process.env.JV_NM + 'dompurify/dist/purify.min.js', 'utf8') });
    return route.abort();
  });
  await page.goto(URL_);
  await page.waitForFunction(() => typeof openSettings === 'function' && typeof S !== 'undefined', null, { timeout: 90000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => openSettings()); await page.waitForTimeout(200);
  await page.click('#setTabs [data-tab="app"]'); await page.waitForTimeout(200);
  return { page, ctx };
}
{ // in the Android app
  const { page, ctx } = await open(true);
  ok(await page.isVisible('#sKiosk'), 'the kiosk switch shows in the Android app (App tab)');
  ok(/Off/.test(await page.textContent('#kioskStatus')) && !(await page.isChecked('#sKiosk')), 'starts off');
  await page.click('#sKiosk'); await page.waitForTimeout(1000);
  ok((await page.evaluate(() => window.__kiosk)).join() === 'true', 'turning it on calls setKiosk(true)');
  ok(/pinned/.test(await page.textContent('#kioskStatus')), 'status after turning on: ' + await page.textContent('#kioskStatus'));
  await page.evaluate(() => { window.__k.locked = true; window.__k.pinned = false; window.__k.owner = true; openSettings(); }); await page.waitForTimeout(200); await page.click('#setTabs [data-tab="app"]'); await page.waitForTimeout(200);
  ok(/full kiosk/.test(await page.textContent('#kioskStatus')), 'device-owner lock is reported: ' + await page.textContent('#kioskStatus'));
  await page.screenshot({ path: 'kiosk_settings.png' });
  await page.click('#sKiosk'); await page.waitForTimeout(1000);
  ok((await page.evaluate(() => window.__kiosk)).join() === 'true,false', 'turning it off calls setKiosk(false)');
  await ctx.close();
}
{ // in a browser tab
  const { page, ctx } = await open(false);
  ok(!(await page.isVisible('#kioskNative')), 'hidden in a browser (no Android shell)');
  await ctx.close();
}
console.log(log.join('\n')); console.log('\n' + (fail.length ? fail.join('\n') : 'ALL PASS'));
await browser.close();
