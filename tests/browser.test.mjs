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

async function startViewer(...files) {
  const child = spawn(binary, [...files, '--no-open', '--port', '0'], { cwd: root, windowsHide: true });
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

/** ビューアとブラウザを起動して run を実行し、最後にページエラーがないことを確かめて片付ける */
async function withViewer(dir, files, run) {
  const server = await startViewer(...files);
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url);
    await run(page, server);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function ready(page) {
  await page.waitForFunction(() => S.data && S.version >= 0 && !S.loading);
  assert.equal(await page.locator('#error').isVisible(), false);
}

/** ファイルを保存し、ビューアがそれを読み直し終えるまで待つ */
async function saveAndWait(page, save) {
  const version = await page.evaluate(() => S.version);
  await save();
  await page.waitForFunction((v) => S.version > v && !S.loading, version);
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
  await withViewer(dir, [old, newer], async (page, server) => {
    await ready(page);

    await t.test('same DOM with different CSS is highlighted', async () => {
      assert.equal(await page.evaluate(() => S.data.diff.hunks.length), 0);
      assert.ok(await page.locator('#pane-new .hl.mod').count() > 0);
      assert.match(await page.locator('#hunk-note').textContent(), /描画差分/);
    });

    await t.test('CSS-only save refreshes without touching HTML', async () => {
      await saveAndWait(page, () => writeFile(path.join(after, 'style.css'), css('red')));
      assert.equal(await page.locator('#pane-new .hl.mod').count(), 0);
      await saveAndWait(page, () => writeFile(path.join(after, 'style.css'), css('red') + 'h1::after { content: "X"; color: blue }'));
      assert.ok(await page.locator('#pane-new .hl.mod').count() > 0);
    });

    await t.test('normal source and rendering navigation still works', async () => {
      await saveAndWait(page, () => writeFile(newer, html.replace('Heading', 'New heading')));
      await page.frameLocator('#pane-new iframe:not(.loading)').locator('h1').click();
      assert.ok(await page.locator('#rows .row.cur').count() > 0);
      await page.locator('#next').click();
      await page.locator('#rows .row.cur').first().click();
    });

    await t.test('root background changes are compared too', async () => {
      await saveAndWait(page, () => writeFile(path.join(after, 'style.css'), css('red') + 'html { background: pink }'));
      assert.equal(await page.evaluate(() => S.items.some((it) => it.side === 'new'
        && it.el.tagName === 'HTML' && it.kind === 'mod')), true);
    });

    await t.test('ancestors that only grow because of an added child are not marked', async () => {
      await saveAndWait(page, async () => {
        await writeFile(path.join(after, 'style.css'), css('red'));
        await writeFile(newer, html.replace('</body>', '<p>Added</p></body>'));
      });
      const kinds = await page.evaluate(() => S.items.filter((it) => it.side === 'new')
        .map((it) => it.el.tagName + ':' + it.kind));
      assert.deepEqual(kinds, ['P:add']);
    });

    await t.test('prev/next buttons stay in place while the note text changes', async () => {
      await saveAndWait(page, async () => {
        await writeFile(newer, html.replace('Heading', 'New heading')
          .replace('</body>', '<p>Added</p>\n<script></script></body>'));
      });
      const xs = new Set();
      const record = async () => {
        const [prev, next] = await Promise.all([page.locator('#prev').boundingBox(), page.locator('#next').boundingBox()]);
        xs.add(`${prev.x},${next.x}`);
      };
      const n = await page.evaluate(() => S.data.diff.hunks.length);
      for (let i = 0; i < n; i++) { await page.locator('#next').click(); await record(); }
      await page.evaluate(() => setNote(''));
      await record();
      await page.evaluate(() => setNote('とても長い説明文'.repeat(20)));
      await record();
      await page.evaluate(() => { els.counter.textContent = '123 / 456'; });
      await record();
      assert.equal(xs.size, 1, [...xs].join(' | '));
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
      await saveAndWait(page, () => writeFile(newer, html.replace('</body>', script + '</body>')));
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
  });
});

test('file tree picker, keyboard navigation and server boundaries', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'html-viewer-picker-'));
  const before = path.join(dir, 'old'), after = path.join(dir, 'new');
  await mkdir(before); await mkdir(path.join(after, 'sub'), { recursive: true });
  const lines = ['<h1>Title</h1>', '<p>a</p>', '<p>b</p>', '<p>c</p>', '<p>d</p>', '<p>Footer</p>'];
  const doc = (ls) => `<!doctype html><html><body>\n${ls.join('\n')}\n</body></html>`;
  const old = path.join(before, 'index.html'), newer = path.join(after, 'index.html');
  await writeFile(old, doc(lines));
  // 見出しの変更・インデントだけの変更・末尾の追加で、離れた3つの変更を作る
  await writeFile(newer, doc(['<h1>New title</h1>', lines[1], '  <p>b</p>', lines[3], lines[4], lines[5], '<p>Added</p>']));
  await writeFile(path.join(before, '.hidden.html'), '');
  await writeFile(path.join(before, 'note.txt'), '');
  await writeFile(path.join(after, 'sub', 'page.html'), '<p>sub</p>');
  await writeFile(path.join(dir, 'secret.txt'), 'secret');
  await withViewer(dir, [], async (page, server) => {
    // Windows のパスの \ は CSS のエスケープになるので、属性セレクタ用にエスケープする
    const li = (p) => page.locator(`#ls-list li[data-path="${p.replace(/[\\"]/g, '\\$&')}"]`);
    const node = (p) => li(p).locator('> .node');

    await t.test('without files the picker opens by itself', async () => {
      await page.locator('#picker').waitFor();
      assert.match(await page.locator('#hunk-note').textContent(), /未選択/);
      assert.equal(await page.locator('#counter').textContent(), '–');
    });

    await t.test('folders expand in place as a tree', async () => {
      await page.locator('#ls-dir').fill(dir);
      await page.locator('#ls-dir').press('Enter');
      await node(before).click();
      await node(old).waitFor();
      assert.deepEqual(await li(before).locator('li').evaluateAll(
        (lis) => lis.map((li) => li.dataset.path.split(/[\\/]/).pop())), ['index.html']);
      await node(old).click();
      assert.equal(await page.locator('#path-old').inputValue(), old);
      assert.equal(await page.locator('input[name=target][value=new]').isChecked(), true);
      assert.match(await li(old).getAttribute('class'), /picked-old/);

      await node(before).click();
      assert.equal(await node(old).isVisible(), false);
      await node(before).click();
      assert.equal(await node(old).isVisible(), true);

      await node(after).click();
      await node(path.join(after, 'sub')).click();
      await node(path.join(after, 'sub', 'page.html')).waitFor();
      await node(newer).click();
      assert.equal(await page.locator('#path-new').inputValue(), newer);
      assert.match(await li(newer).getAttribute('class'), /picked-new/);

      await node(after).dblclick();
      await page.waitForFunction((d) => document.querySelector('#ls-dir').value === d, after);
      await page.locator('#ls-up').click();
      await page.waitForFunction((d) => document.querySelector('#ls-dir').value === d, dir);
    });

    await t.test('a bad path keeps the picker open with an error', async () => {
      await page.locator('#path-old').fill(path.join(dir, 'missing.html'));
      await page.locator('#picker-go').click();
      await page.waitForFunction(() => document.querySelector('#picker-error').textContent !== '');
      assert.equal(await page.locator('#picker').isVisible(), true);
      await page.locator('#path-old').fill(`"${old}"`);
      await page.locator('#picker-go').click();
      await ready(page);
      assert.equal(await page.locator('#picker').isVisible(), false);
      assert.equal(await page.locator('#old-name').textContent(), 'old/index.html');
      assert.equal(await page.locator('#new-name').textContent(), 'new/index.html');
    });

    await t.test('keys and the change list move between changes', async () => {
      const n = await page.evaluate(() => S.data.diff.hunks.length);
      assert.equal(n, 3);
      // 開いた直後は最初の変更にいて、端では反対側へ回り込む
      const counter = () => page.locator('#counter').textContent();
      assert.equal(await counter(), `1 / ${n}`);
      await page.keyboard.press('j');
      assert.equal(await counter(), `2 / ${n}`);
      await page.keyboard.press('k');
      await page.keyboard.press('k');
      assert.equal(await counter(), `${n} / ${n}`);
      await page.keyboard.press('j');
      assert.equal(await counter(), `1 / ${n}`);
      await page.locator('#changes .chg[data-h="1"]').click();
      assert.equal(await page.locator('#counter').textContent(), `2 / ${n}`);
      assert.equal(await page.locator('#rows .row.cur').count() > 0, true);
    });

    await t.test('whitespace-only changes disappear with w', async () => {
      await page.keyboard.press('w');
      await page.waitForFunction(() => !S.loading && S.data.diff.hunks.length === 2);
      assert.equal(await page.locator('#opt-ws').isChecked(), true);
      await page.keyboard.press('w');
      await page.waitForFunction(() => !S.loading && S.data.diff.hunks.length === 3);
    });

    await t.test('o and Escape open and close the picker; keys typed in it are text', async () => {
      await page.keyboard.press('o');
      await page.locator('#picker').waitFor();
      assert.equal(await page.locator('#path-old').inputValue(), old);
      await page.locator('#ls-dir').press('j');
      assert.equal(await page.locator('#counter').textContent(), '2 / 3');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#picker').isVisible(), false);
    });

    await t.test('files outside the compared folder are not served', async () => {
      assert.equal((await fetch(server.url + 'doc/new/sub%2Fpage.html')).status, 200);
      for (const rel of ['%2E%2E%2Fsecret.txt', '..%5Csecret.txt', '%2E%2E%2Fold%2Findex.html'])
        assert.equal((await fetch(server.url + 'doc/new/' + rel)).status, 404, rel);
      assert.equal((await fetch(server.url + 'api/open')).status, 405);
      const post = (type) => fetch(server.url + 'api/open', { method: 'POST', headers: { 'Content-Type': type },
        body: JSON.stringify({ old: newer, new: old }) });
      assert.equal((await post('text/plain')).status, 415);
      assert.equal((await fetch(server.url + 'api/ls?dir=' + encodeURIComponent(old))).status, 400);
      assert.equal((await (await fetch(server.url + 'api/diff')).json()).old.path, old);
    });
  });
});
