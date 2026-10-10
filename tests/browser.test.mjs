import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = process.env.HTML_VIEWER_BIN || path.join(root, 'target', 'debug',
  process.platform === 'win32' ? 'rust-html-viewer.exe' : 'rust-html-viewer');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');

async function startViewer(old, newer) {
  const child = spawn(binary, [old, newer, '--no-open', '--port', '0'], { cwd: root, windowsHide: true });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Viewer startup timed out')); }, 15000);
    child.once('error', (e) => { clearTimeout(timeout); reject(e); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Viewer exited: ${code}: ${output}`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
  });
  return { url, stop: () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  }) };
}

async function ready(page) {
  await page.waitForFunction(() => S.data && S.version >= 0 && !S.loading);
  assert.equal(await page.locator('#error').isVisible(), false);
}

test('CSS comparison, source navigation, stylesheet watching and JS isolation', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'html-viewer-browser-'));
  const before = path.join(dir, 'old'), after = path.join(dir, 'new');
  await mkdir(before); await mkdir(after);
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>\n'
    + '<body><h1>Heading</h1>\n<p>Unchanged</p></body></html>';
  const old = path.join(before, 'index.html'), newer = path.join(after, 'index.html');
  await writeFile(old, html); await writeFile(newer, html);
  const css = (color) => `h1 { color: ${color}; }`;
  await writeFile(path.join(before, 'style.css'), css('red'));
  await writeFile(path.join(after, 'style.css'), css('blue'));
  const server = await startViewer(old, newer);
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url); await ready(page);

    await t.test('same DOM with different CSS is highlighted', async () => {
      assert.equal(await page.evaluate(() => S.data.diff.hunks.length), 0);
      assert.ok(await page.locator('#pane-new .hl.mod').count() > 0);
      assert.match(await page.locator('#hunk-note').textContent(), /描画差分/);
    });

    await t.test('CSS-only save refreshes without touching HTML', async () => {
      const version = await page.evaluate(() => S.version);
      await writeFile(path.join(after, 'style.css'), css('red'));
      await page.waitForFunction((v) => S.version > v && !S.loading, version);
      assert.equal(await page.locator('#pane-new .hl.mod').count(), 0);
      const next = await page.evaluate(() => S.version);
      await writeFile(path.join(after, 'style.css'), css('red') + 'h1::after { content: "X"; color: blue }');
      await page.waitForFunction((v) => S.version > v && !S.loading, next);
      assert.ok(await page.locator('#pane-new .hl.mod').count() > 0);
    });

    await t.test('normal source and rendering navigation still works', async () => {
      const version = await page.evaluate(() => S.version);
      await writeFile(newer, html.replace('Heading', 'New heading'));
      await page.waitForFunction((v) => S.version > v && !S.loading, version);
      await page.frameLocator('#pane-new iframe:not(.loading)').locator('h1').click();
      assert.ok(await page.locator('#rows .row.cur').count() > 0);
      await page.locator('#next').click();
      await page.locator('#rows .row.cur').first().click();
    });

    await t.test('root background changes are compared too', async () => {
      const version = await page.evaluate(() => S.version);
      await writeFile(path.join(after, 'style.css'), css('red') + 'html { background: pink }');
      await page.waitForFunction((v) => S.version > v && !S.loading, version);
      assert.equal(await page.evaluate(() => S.items.some((it) => it.side === 'new'
        && it.el.tagName === 'HTML' && it.kind === 'mod')), true);
    });

    await t.test('JS runs without parent access or API writes', async () => {
      const script = `<script>
        document.body.dataset.executed = 'yes';
        try { parent.document.body.dataset.previewAttack = 'yes'; document.body.dataset.parentAccess = 'yes'; }
        catch { document.body.dataset.parentAccess = 'blocked'; }
        try { localStorage.setItem('attack', 'yes'); document.body.dataset.storage = 'yes'; }
        catch { document.body.dataset.storage = 'blocked'; }
        Promise.allSettled([
          fetch('/api/version').then(() => document.body.dataset.apiRead = 'yes')
            .catch(() => document.body.dataset.apiRead = 'blocked'),
          fetch('/api/open', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({old: ${JSON.stringify(old)}, new: ${JSON.stringify(old)}}) })
        ]).then(() => document.body.dataset.requestsDone = 'yes');
      </script>`;
      const version = await page.evaluate(() => S.version);
      await writeFile(newer, html.replace('</body>', script + '</body>'));
      await page.waitForFunction((v) => S.version > v && !S.loading, version);
      assert.equal(await page.frameLocator('#pane-new iframe:not(.loading)').locator('body').getAttribute('data-executed'), null);
      const statuses = [];
      page.on('response', (r) => { if (/\/api\/(version|open)$/.test(r.url()) && r.status() === 403) statuses.push(r.status()); });
      await page.locator('#opt-js').check();
      await page.waitForFunction(() => S.js && !S.loading && panes.new.doc === null);
      const body = page.frameLocator('#pane-new iframe:not(.loading)').locator('body');
      await body.waitFor();
      await page.waitForFunction(() => !S.loading);
      assert.equal(await body.getAttribute('data-executed'), 'yes');
      assert.equal(await body.getAttribute('data-parent-access'), 'blocked');
      assert.equal(await body.getAttribute('data-storage'), 'blocked');
      await page.waitForResponse((r) => r.url().endsWith('/api/version') && r.status() === 200);
      // Polls can arrive before the attack requests finish; use the iframe state too.
      const frame = page.frames().find((f) => f.url().includes('/doc/new/'));
      await frame.waitForFunction(() => document.body.dataset.requestsDone === 'yes');
      assert.equal(await body.getAttribute('data-api-read'), 'blocked');
      assert.ok(statuses.length >= 1, 'Preview POST must be refused');
      assert.equal((await fetch(server.url + 'api/version', { headers: { Origin: 'null' } })).status, 403);
      assert.equal(await page.locator('body').getAttribute('data-preview-attack'), null);
      assert.equal((await (await fetch(server.url + 'api/diff')).json()).new.path, newer);
      await page.locator('#next').click();
      assert.equal(await page.locator('#opt-sync').isDisabled(), true);
      await page.locator('[data-mode="single"]').click();
      await page.keyboard.down('Space'); await page.keyboard.up('Space');
      assert.match(await page.locator('#hunk-note').textContent(), /JS隔離表示/);
      await page.reload(); await ready(page);
      assert.equal(await page.locator('#opt-js').isChecked(), false);
      assert.equal(await page.evaluate(() => !!panes.new.doc), true);
      assert.equal(await page.locator('#opt-sync').isDisabled(), false);
    });

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
