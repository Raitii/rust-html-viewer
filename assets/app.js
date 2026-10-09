'use strict';

// =====================================================================
//  HTML Diff Viewer
//  - 上: 旧/新のレンダリング結果（変更要素をオーバーレイで強調）
//  - 下: ソースの差分
//  - 「変更」単位で両方が同時に追従するので、視線と思考を切り替えずに済む
// =====================================================================

const $ = (s, root = document) => root.querySelector(s);
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('hv.' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('hv.' + k, JSON.stringify(v)); } catch { /* 保存できなくても動作は続ける */ }
  },
};

const CTX = 3;            // 折りたたまずに見せる前後の行数
const ANCHOR = 0.3;       // スクロール位置合わせの基準（ビューポート上端からの割合）

const S = {
  data: null,             // /api/diff の結果
  version: -1,
  cur: -1,                // 現在フォーカスしている変更（hunk）
  mode: store.get('mode', 'split'),
  ws: store.get('ws', false),
  sync: store.get('sync', true),
  follow: store.get('follow', true),
  js: store.get('js', false),
  expanded: new Set(),    // 展開済みの折りたたみ
  items: [],              // 描画上の変更要素
  itemByEl: new Map(),
  hunkItems: [],
  o2n: new Map(),         // 旧要素 → 対応する新要素
  n2o: new Map(),
  idx: { o: [], n: [] },  // 行番号 → lines のインデックス
  rowEls: [],
  prevText: null,
  loading: false,
  pending: false,
  suppressSyncUntil: 0,
};

const els = {
  render: $('#render'),
  rows: $('#rows'),
  srcScroll: $('#source-scroll'),
  rail: $('#rail'),
  counter: $('#counter'),
  note: $('#hunk-note'),
  stats: $('#stats'),
  live: $('#live'),
  toast: $('#toast'),
  error: $('#error'),
};

function mkPane(side) {
  const root = $('#pane-' + side);
  const hoverBox = document.createElement('div');
  hoverBox.className = 'hover-box';
  const hoverTag = document.createElement('div');
  hoverTag.className = 'hover-tag';
  return {
    side, root,
    frame: $('iframe', root),
    overlay: $('.overlay', root),
    hoverBox, hoverTag, hoverEl: null,
    doc: null, win: null,
    els: [], lines: [], ends: [],
    ignoreScrollUntil: 0,
  };
}
const panes = { old: mkPane('old'), new: mkPane('new') };
const other = (p) => (p === panes.old ? panes.new : panes.old);

// ---------------------------------------------------------------------
//  読み込み
// ---------------------------------------------------------------------

async function fetchDiff() {
  const r = await fetch(`/api/diff?ws=${S.ws ? 1 : 0}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

/** 裏で新しい iframe を読み込み、スクロール位置を戻してから差し替える（ちらつき防止） */
function loadFrame(p, name, version, scrollY) {
  return new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.title = p.frame.title;
    f.className = 'loading';
    f.addEventListener('load', () => {
      if (scrollY) f.contentWindow.scrollTo(0, scrollY);
      const prev = p.frame;
      p.frame = f;
      f.className = '';
      prev.remove();
      setHover(p, null);
      attachFrame(p);
      resolve();
    }, { once: true });
    f.src = `/doc/${p.side}/${encodeURIComponent(name)}?v=${version}${S.js ? '&js=1' : ''}`;
    p.root.insertBefore(f, p.overlay);
  });
}

function attachFrame(p) {
  p.win = p.frame.contentWindow;
  p.doc = p.frame.contentDocument;
  p.win.addEventListener('scroll', () => onPaneScroll(p), { passive: true });
  p.win.addEventListener('resize', scheduleDraw);
  p.doc.addEventListener('click', (e) => onFrameClick(p, e), true);
  p.doc.addEventListener('submit', (e) => e.preventDefault(), true);
  p.doc.addEventListener('mousemove', (e) => onFrameHover(p, e), { passive: true });
  p.doc.addEventListener('mouseleave', () => setHover(p, null));
  p.doc.addEventListener('keydown', onKeyDown);
  p.doc.addEventListener('keyup', onKeyUp);
}

async function reload(reason) {
  if (S.loading) { S.pending = reason; return; }
  S.loading = true;
  try {
    const data = await fetchDiff();
    const keep = {
      old: panes.old.win ? panes.old.win.scrollY : 0,
      new: panes.new.win ? panes.new.win.scrollY : 0,
      src: els.srcScroll.scrollTop,
    };
    const framesStale = data.version !== S.version || reason === 'js' || !panes.new.doc;
    const prevText = S.prevText;

    S.data = data;
    buildIndexes();
    if (framesStale) {
      await Promise.all([
        loadFrame(panes.old, data.old.name, data.version, keep.old),
        loadFrame(panes.new, data.new.name, data.version, keep.new),
      ]);
    }
    S.version = data.version;
    hideError();

    analyze();
    renderHeader();
    renderSource();
    els.srcScroll.scrollTop = keep.src;
    S.prevText = textSnapshot();

    const n = data.diff.hunks.length;
    if (reason === 'init') {
      focusHunk(n ? 0 : -1);
    } else if (reason === 'file' && S.follow && prevText) {
      const edit = firstEdit(prevText, S.prevText);
      if (edit) gotoEdit(edit);
      else focusHunk(Math.min(S.cur, n - 1), { scroll: false });
    } else {
      focusHunk(Math.min(Math.max(S.cur, n ? 0 : -1), n - 1), { scroll: false });
    }
    if (reason === 'file') toast(`更新しました ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    S.loading = false;
    if (S.pending) { const r = S.pending; S.pending = false; reload(r); }
  }
}

function buildIndexes() {
  const { lines } = S.data.diff;
  S.idx = { o: [], n: [] };
  lines.forEach((l, i) => {
    if (l.o != null) S.idx.o[l.o] = i;
    if (l.n != null) S.idx.n[l.n] = i;
  });
}

const lineText = (l) => l.s.map((s) => s[1]).join('');

function textSnapshot() {
  const snap = { old: [], new: [] };
  for (const l of S.data.diff.lines) {
    if (l.o != null) snap.old.push(lineText(l));
    if (l.n != null) snap.new.push(lineText(l));
  }
  return snap;
}

/** 前回との比較で、最初に書き換わった行を返す（保存時の追従用） */
function firstEdit(prev, cur) {
  for (const side of ['new', 'old']) {
    const a = prev[side], b = cur[side];
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return { side, line: Math.min(i + 1, Math.max(b.length, 1)) };
    }
  }
  return null;
}

function gotoEdit({ side, line }) {
  const key = side === 'new' ? 'n' : 'o';
  const k = S.data.diff.hunks.findIndex((h) => line >= h[key][0] && line <= h[key][0] + Math.max(h[key][1], 1) - 1);
  if (k >= 0) { focusHunk(k); return; }
  revealSourceLine(side, line);
  const p = panes[side];
  const el = elementForLine(p, line);
  if (el) scrollPaneTo(p, el, { flash: true });
}

// ---------------------------------------------------------------------
//  描画結果の差分（DOM を比較）
// ---------------------------------------------------------------------

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);

function collect(p) {
  const list = [], ends = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (SKIP_TAGS.has(c.tagName)) continue;
      const i = list.length;
      list.push(c);
      ends.push(0);
      walk(c);
      ends[i] = list.length;
    }
  };
  if (p.doc && p.doc.body) walk(p.doc.body);
  p.els = list;
  p.ends = ends;
  p.lines = list.map((e) => +e.getAttribute('data-hv-line') || 0);
}

/** 要素自身（子孫を除く）の見た目を表す署名。タグ名・属性・直下のテキスト */
function signature(el) {
  let text = '';
  for (const n of el.childNodes) if (n.nodeType === 3) text += n.data;
  text = text.replace(/\s+/g, ' ').trim();
  const attrs = [];
  for (const a of el.attributes) {
    if (!a.name.startsWith('data-hv-')) attrs.push(a.name + '=' + a.value.replace(/\s+/g, ' ').trim());
  }
  attrs.sort();
  return el.tagName + '\u0002' + attrs.join('\u0001') + '\u0002' + text;
}

/** 最長共通部分列で対応する要素のペアを求める */
function lcs(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }

  const pairs = [];
  for (let i = 0; i < s; i++) pairs.push([i, i]);
  const n = ea - s, m = eb - s;
  if (n > 0 && m > 0) {
    if (n * m <= 6e6) {
      const W = m + 1;
      const dp = new Uint32Array((n + 1) * W);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * W + j] = a[s + i] === b[s + j]
            ? dp[(i + 1) * W + j + 1] + 1
            : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[s + i] === b[s + j]) { pairs.push([s + i, s + j]); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
        else j++;
      }
    } else {
      // 巨大な場合は貪欲法で近似
      const pos = new Map();
      for (let j = s; j < eb; j++) {
        if (!pos.has(b[j])) pos.set(b[j], []);
        pos.get(b[j]).push(j);
      }
      let last = s - 1;
      for (let i = s; i < ea; i++) {
        const list = pos.get(a[i]);
        if (!list) continue;
        while (list.length && list[0] <= last) list.shift();
        if (list.length && list[0] - last < 200) { last = list.shift(); pairs.push([i, last]); }
      }
    }
  }
  for (let k = 0; k < a.length - ea; k++) pairs.push([ea + k, eb + k]);
  return pairs;
}

function analyze() {
  const po = panes.old, pn = panes.new;
  collect(po);
  collect(pn);

  const intern = new Map();
  const id = (el) => {
    const sg = signature(el);
    let v = intern.get(sg);
    if (v === undefined) { v = intern.size; intern.set(sg, v); }
    return v;
  };
  const A = po.els.map(id), B = pn.els.map(id);
  const pairs = lcs(A, B);

  S.o2n = new Map();
  S.n2o = new Map();
  S.items = [];
  S.itemByEl = new Map();
  const link = (oi, nj) => {
    S.o2n.set(po.els[oi], pn.els[nj]);
    S.n2o.set(pn.els[nj], po.els[oi]);
  };
  const addItem = (p, i, kind) => {
    const it = { side: p.side, el: p.els[i], index: i, kind, hunk: -1, inner: false, box: null };
    S.items.push(it);
    S.itemByEl.set(it.el, it);
  };

  // 対応が取れなかった区間ごとに、同じタグ同士を「変更」、残りを追加/削除とする
  let ia = 0, ib = 0;
  for (const [i, j] of [...pairs, [A.length, B.length]]) {
    const used = new Set();
    for (let oi = ia; oi < i; oi++) {
      const tag = po.els[oi].tagName;
      let match = -1;
      for (let nj = ib; nj < j; nj++) {
        if (!used.has(nj) && pn.els[nj].tagName === tag) { match = nj; break; }
      }
      if (match >= 0) {
        used.add(match);
        addItem(po, oi, 'mod');
        addItem(pn, match, 'mod');
        link(oi, match);
      } else {
        addItem(po, oi, 'del');
      }
    }
    for (let nj = ib; nj < j; nj++) if (!used.has(nj)) addItem(pn, nj, 'add');
    if (i < A.length) link(i, j);
    ia = i + 1;
    ib = j + 1;
  }

  // 追加/削除された要素の内側は個別に枠を出さない（枠だらけになるのを防ぐ）
  for (const it of S.items) {
    for (let a = it.el.parentElement; a; a = a.parentElement) {
      const parent = S.itemByEl.get(a);
      if (parent && (parent.kind === 'add' || parent.kind === 'del' || parent.inner)) { it.inner = true; break; }
    }
  }

  // 各要素を、ソース上で重なる変更ブロックに割り当てる
  const hunks = S.data.diff.hunks;
  S.hunkItems = hunks.map(() => []);
  for (const it of S.items) {
    const p = panes[it.side];
    const start = p.lines[it.index];
    const nextIdx = p.ends[it.index];
    const end = Math.max(start, nextIdx < p.els.length ? p.lines[nextIdx] - 1 : Infinity);
    it.hunk = nearestHunk(it.side === 'new' ? 'n' : 'o', start, end);
    if (it.hunk >= 0) S.hunkItems[it.hunk].push(it);
  }

  // オーバーレイの枠を作り直す
  for (const p of [po, pn]) {
    const boxes = [];
    for (const it of S.items) {
      if (it.side !== p.side || it.inner) continue;
      it.box = document.createElement('div');
      it.box.className = 'hl ' + it.kind;
      boxes.push(it.box);
    }
    p.overlay.replaceChildren(...boxes, p.hoverBox, p.hoverTag);
  }
  drawAll();
}

function nearestHunk(key, start, end) {
  const hunks = S.data.diff.hunks;
  let best = -1, bestScore = Infinity;
  hunks.forEach((h, k) => {
    const hs = h[key][0], he = hs + Math.max(h[key][1], 1) - 1;
    const overlaps = hs <= end && he >= start;
    // 重なるものを最優先し、その中では要素の開始行に近いものを選ぶ
    const score = overlaps ? Math.abs(hs - start) : 1e9 + Math.min(Math.abs(hs - end), Math.abs(he - start));
    if (score < bestScore) { bestScore = score; best = k; }
  });
  return best;
}

const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; };

// ---------------------------------------------------------------------
//  オーバーレイ描画
// ---------------------------------------------------------------------

let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawAll(); });
}

function drawAll() {
  for (const p of [panes.old, panes.new]) {
    if (!p.doc) continue;
    const vh = p.frame.clientHeight;
    for (const it of S.items) {
      if (it.side !== p.side || !it.box) continue;
      const r = it.el.getBoundingClientRect();
      const hidden = (r.width === 0 && r.height === 0) || r.bottom < -40 || r.top > vh + 40;
      it.box.style.display = hidden ? 'none' : '';
      if (!hidden) placeBox(it.box, r);
    }
    if (p.hoverEl) drawHover(p);
  }
}

function placeBox(box, r) {
  box.style.left = r.left - 2 + 'px';
  box.style.top = r.top - 2 + 'px';
  box.style.width = Math.max(r.width + 4, 6) + 'px';
  box.style.height = Math.max(r.height + 4, 6) + 'px';
}

function flashElement(p, el) {
  setTimeout(() => {
    const box = document.createElement('div');
    box.className = 'flash-box';
    placeBox(box, el.getBoundingClientRect());
    p.overlay.appendChild(box);
    setTimeout(() => box.remove(), 1300);
  }, 380);
}

// ---------------------------------------------------------------------
//  スクロール・同期
// ---------------------------------------------------------------------

function onPaneScroll(p) {
  scheduleDraw();
  const now = performance.now();
  if (!S.sync || now < p.ignoreScrollUntil || now < S.suppressSyncUntil) return;
  syncFrom(p);
}

/** 画面上で見えている要素の対応先を基準に、反対側を同じ位置へスクロールする */
function syncFrom(src) {
  const dst = other(src);
  if (!src.doc || !dst.doc) return;
  const map = src.side === 'old' ? S.o2n : S.n2o;
  const vh = src.win.innerHeight, vw = src.win.innerWidth;
  const y0 = Math.round(vh * ANCHOR);
  const srcMax = src.doc.documentElement.scrollHeight - vh;
  const dstMax = dst.doc.documentElement.scrollHeight - dst.win.innerHeight;
  let destY = null;

  if (src.win.scrollY <= 0) destY = 0;
  else if (src.win.scrollY >= srcMax - 1) destY = dstMax;
  else {
    for (const fx of [0.5, 0.3, 0.7, 0.1, 0.9]) {
      let el = src.doc.elementFromPoint(vw * fx, y0);
      while (el && !map.has(el)) el = el.parentElement;
      if (!el) continue;
      const r = el.getBoundingClientRect(), r2 = map.get(el).getBoundingClientRect();
      const frac = r.height > 0 ? (y0 - r.top) / r.height : 0;
      destY = dst.win.scrollY + r2.top + frac * r2.height - y0;
      break;
    }
    if (destY === null) destY = srcMax > 0 ? (src.win.scrollY / srcMax) * dstMax : 0;
  }
  if (Math.abs(destY - dst.win.scrollY) < 1 && dst.win.scrollX === src.win.scrollX) return;
  dst.ignoreScrollUntil = performance.now() + 80;
  dst.win.scrollTo(src.win.scrollX, destY);
}

function scrollPaneTo(p, el, { smooth = true, flash = false } = {}) {
  while (el && !isVisible(el)) el = el.parentElement;
  if (!el || !p.win) return;
  const r = el.getBoundingClientRect();
  const top = p.win.scrollY + r.top - p.win.innerHeight * ANCHOR;
  p.win.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  if (flash) flashElement(p, el);
}

/** ソース行番号に最も近い（その行以前に始まる最後の）要素 */
function elementForLine(p, line) {
  let lo = 0, hi = p.lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p.lines[mid] <= line) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? p.els[ans] : p.els[0] || null;
}

function scrollSourceToRow(row, smooth = true) {
  if (!row) return;
  const box = els.srcScroll;
  const top = row.offsetTop - box.clientHeight * ANCHOR;
  box.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

// ---------------------------------------------------------------------
//  変更（hunk）へのフォーカス：ソースと描画の両方を同時に動かす
// ---------------------------------------------------------------------

function focusHunk(k, { scroll = true, from = null } = {}) {
  const hunks = S.data ? S.data.diff.hunks : [];
  S.cur = k;
  els.counter.textContent = hunks.length ? `${k + 1} / ${hunks.length}` : '差分なし';

  for (const r of els.rows.querySelectorAll('.row.cur')) r.classList.remove('cur');
  for (const t of els.rail.querySelectorAll('.tick.cur')) t.classList.remove('cur');
  for (const it of S.items) {
    if (!it.box) continue;
    it.box.classList.toggle('cur', it.hunk === k);
    it.box.classList.remove('pulse');
  }
  if (k < 0) { els.note.textContent = ''; return; }

  for (const r of els.rows.querySelectorAll(`.row[data-h="${k}"]`)) r.classList.add('cur');
  const tick = els.rail.querySelector(`.tick[data-h="${k}"]`);
  if (tick) tick.classList.add('cur');

  const h = hunks[k];
  const items = S.hunkItems[k] || [];
  const visible = items.filter((it) => !it.inner && isVisible(it.el));
  const count = (kind) => visible.filter((it) => it.kind === kind && it.side === (kind === 'del' ? 'old' : 'new')).length;
  els.note.textContent = visible.length
    ? `描画: ${[['add', '+'], ['del', '−'], ['mod', '~']].map(([kd, s]) => count(kd) && s + count(kd)).filter(Boolean).join(' ')}`
    : '描画上の変化なし（head・script・空白など）';

  if (!scroll) return;

  if (from !== 'source') scrollSourceToRow(S.rowEls[h.first]);
  if (from !== 'render') {
    // 旧・新それぞれ、その変更に対応する位置へ同時にスクロールする
    S.suppressSyncUntil = performance.now() + 700;
    const nIt = visible.find((it) => it.side === 'new');
    const oIt = visible.find((it) => it.side === 'old');
    scrollPaneTo(panes.new, nIt ? nIt.el : elementForLine(panes.new, h.n[0]));
    scrollPaneTo(panes.old, oIt ? oIt.el : elementForLine(panes.old, h.o[0]));
  }
  setTimeout(() => {
    for (const it of items) {
      if (!it.box) continue;
      it.box.classList.remove('pulse');
      void it.box.offsetWidth;
      it.box.classList.add('pulse');
    }
  }, 350);
}

function step(d) {
  const n = S.data ? S.data.diff.hunks.length : 0;
  if (!n) return;
  focusHunk(S.cur < 0 ? (d > 0 ? 0 : n - 1) : (S.cur + d + n) % n);
}

// ---------------------------------------------------------------------
//  ソース差分の表示
// ---------------------------------------------------------------------

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function rowHtml(l, i, hunkStart) {
  const mk = l.k === 'd' ? '−' : l.k === 'i' ? '+' : '';
  const code = l.s.map(([em, t]) => (em ? `<em>${esc(t)}</em>` : esc(t))).join('');
  const cls = `row ${l.k}${hunkStart ? ' hunk-start' : ''}`;
  return `<div class="${cls}" data-i="${i}"${l.h != null ? ` data-h="${l.h}"` : ''}>`
    + `<span class="ln">${l.o ?? ''}</span><span class="ln">${l.n ?? ''}</span>`
    + `<span class="mk">${mk}</span><span class="code">${code || ' '}</span></div>`;
}

function renderSource() {
  const { lines, hunks } = S.data.diff;
  const out = [];
  if (!hunks.length) out.push('<div class="empty">ソースに差分はありません。</div>');
  let i = 0;
  while (i < lines.length) {
    if (lines[i].k !== 'e') {
      out.push(rowHtml(lines[i], i, i > 0 && lines[i - 1].h !== lines[i].h));
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].k === 'e') j++;
    const key = `${lines[i].o}:${lines[i].n}`;
    const head = i === 0 ? 0 : CTX;
    const tail = j === lines.length ? 0 : CTX;
    if (j - i > head + tail + 2 && !S.expanded.has(key)) {
      for (let k = i; k < i + head; k++) out.push(rowHtml(lines[k], k));
      out.push(`<button class="fold" data-key="${key}" data-from="${i + head}" data-to="${j - tail}">⋯ ${j - i - head - tail} 行（変更なし）を表示</button>`);
      for (let k = j - tail; k < j; k++) out.push(rowHtml(lines[k], k));
    } else {
      for (let k = i; k < j; k++) out.push(rowHtml(lines[k], k));
    }
    i = j;
  }
  els.rows.innerHTML = out.join('');
  S.rowEls = [];
  for (const r of els.rows.querySelectorAll('.row')) S.rowEls[+r.dataset.i] = r;
  buildRail();
}

function rerenderSourceKeepingScroll() {
  const top = els.srcScroll.scrollTop;
  renderSource();
  els.srcScroll.scrollTop = top;
  focusHunk(S.cur, { scroll: false });
}

/** 折りたたまれていれば展開して、その行を表示・点滅させる */
function revealSourceLine(side, line) {
  const i = S.idx[side === 'new' ? 'n' : 'o'][line];
  if (i == null) return;
  if (!S.rowEls[i]) {
    for (const f of els.rows.querySelectorAll('.fold')) {
      if (i >= +f.dataset.from && i < +f.dataset.to) { S.expanded.add(f.dataset.key); break; }
    }
    rerenderSourceKeepingScroll();
  }
  const row = S.rowEls[i];
  if (!row) return;
  scrollSourceToRow(row);
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}

function buildRail() {
  const total = els.rows.scrollHeight || 1;
  const ticks = [];
  S.data.diff.hunks.forEach((h, k) => {
    const first = S.rowEls[h.first];
    const last = S.rowEls[h.first + h.o[1] + h.n[1] - 1] || first;
    if (!first) return;
    const kind = h.o[1] && h.n[1] ? 'mod' : h.n[1] ? 'add' : 'del';
    const top = (first.offsetTop / total) * 100;
    const height = ((last.offsetTop + last.offsetHeight - first.offsetTop) / total) * 100;
    ticks.push(`<div class="tick ${kind}" data-h="${k}" style="top:${top}%;height:${height}%" title="変更 ${k + 1}"></div>`);
  });
  els.rail.innerHTML = ticks.join('');
}

// ---------------------------------------------------------------------
//  操作
// ---------------------------------------------------------------------

function onFrameClick(p, e) {
  e.preventDefault();
  e.stopPropagation();
  let el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
  for (let a = el; a; a = a.parentElement) {
    const it = S.itemByEl.get(a);
    if (it && it.hunk >= 0) { focusHunk(it.hunk, { from: 'render' }); revealSourceLine(p.side, +a.getAttribute('data-hv-line')); return; }
  }
  while (el && !el.hasAttribute('data-hv-line')) el = el.parentElement;
  if (el) revealSourceLine(p.side, +el.getAttribute('data-hv-line'));
}

function onFrameHover(p, e) {
  let el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
  if (!el || el === p.doc.body || el === p.doc.documentElement) el = null;
  setHover(p, el);
}

let hoverRow = null;
function setHover(p, el) {
  if (p.hoverEl === el) return;
  p.hoverEl = el;
  if (hoverRow) { hoverRow.classList.remove('hover'); hoverRow = null; }
  if (!el) { p.hoverBox.style.display = p.hoverTag.style.display = 'none'; return; }
  const line = +el.getAttribute('data-hv-line');
  const i = S.idx[p.side === 'new' ? 'n' : 'o'][line];
  if (i != null && S.rowEls[i]) { hoverRow = S.rowEls[i]; hoverRow.classList.add('hover'); }
  drawHover(p);
}

function drawHover(p) {
  const el = p.hoverEl;
  const r = el.getBoundingClientRect();
  placeBox(p.hoverBox, r);
  p.hoverBox.style.display = 'block';
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '';
  p.hoverTag.textContent = `L${el.getAttribute('data-hv-line')}  ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}`;
  p.hoverTag.style.left = Math.max(0, r.left) + 'px';
  p.hoverTag.style.top = (r.top > 20 ? r.top - 18 : r.bottom + 2) + 'px';
  p.hoverTag.style.display = 'block';
}

els.rows.addEventListener('click', (e) => {
  const fold = e.target.closest('.fold');
  if (fold) { S.expanded.add(fold.dataset.key); rerenderSourceKeepingScroll(); return; }
  const row = e.target.closest('.row');
  if (!row || window.getSelection().toString()) return;
  const l = S.data.diff.lines[+row.dataset.i];
  if (l.h != null && l.h !== S.cur) focusHunk(l.h, { from: 'source' });
  S.suppressSyncUntil = performance.now() + 700;
  const pn = panes.new, po = panes.old;
  if (l.n != null) scrollPaneTo(pn, elementForLine(pn, l.n), { flash: true });
  if (l.o != null) scrollPaneTo(po, elementForLine(po, l.o), { flash: l.n == null });
  if (l.n == null) scrollPaneTo(pn, elementForLine(pn, Math.max(1, S.data.diff.hunks[l.h].n[0])));
});

els.rail.addEventListener('click', (e) => {
  const t = e.target.closest('.tick');
  if (t) focusHunk(+t.dataset.h);
});

$('#prev').addEventListener('click', () => step(-1));
$('#next').addEventListener('click', () => step(1));

function setMode(m) {
  S.mode = m;
  store.set('mode', m);
  els.render.classList.toggle('single', m === 'single');
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === m);
  requestAnimationFrame(() => { scheduleDraw(); if (S.sync && panes.new.doc) syncFrom(panes.new); });
}
for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));

function bindToggle(id, key, onChange) {
  const box = $('#' + id);
  box.checked = S[key];
  box.addEventListener('change', () => {
    S[key] = box.checked;
    store.set(key, box.checked);
    if (onChange) onChange();
  });
  return box;
}
const toggles = {
  ws: bindToggle('opt-ws', 'ws', () => reload('ws')),
  sync: bindToggle('opt-sync', 'sync', () => { if (S.sync) syncFrom(panes.new); }),
  follow: bindToggle('opt-follow', 'follow'),
  js: bindToggle('opt-js', 'js', () => reload('js')),
};
function flip(key) {
  toggles[key].checked = !toggles[key].checked;
  toggles[key].dispatchEvent(new Event('change'));
  toast(`${toggles[key].parentElement.textContent.trim()}: ${toggles[key].checked ? 'ON' : 'OFF'}`);
}

function setPeek(on) {
  if (S.mode !== 'single') return;
  if (on && S.sync) syncFrom(panes.new);
  els.render.classList.toggle('peek', on);
  scheduleDraw();
}

function onKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && t.ownerDocument === document && t.matches && t.matches('input:not([type=checkbox]), textarea, select')) return;
  switch (e.key) {
    case 'j': case 'n': case 'F7':
      step(e.shiftKey && e.key === 'F7' ? -1 : 1); break;
    case 'k': case 'p':
      step(-1); break;
    case 'v': setMode(S.mode === 'split' ? 'single' : 'split'); break;
    case 'w': flip('ws'); break;
    case 's': flip('sync'); break;
    case 'f': flip('follow'); break;
    case ' ':
      if (S.mode !== 'single') return;
      if (!e.repeat) setPeek(true);
      break;
    default: return;
  }
  e.preventDefault();
}
function onKeyUp(e) {
  if (e.key === ' ') setPeek(false);
}
document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => setPeek(false));
window.addEventListener('resize', () => { scheduleDraw(); if (S.data) buildRail(); });

// 描画エリアとソースの境界をドラッグで調整
(() => {
  const split = $('#splitter');
  const main = $('#main');
  const apply = (pct) => { els.render.style.height = Math.min(90, Math.max(10, pct)) + '%'; };
  apply(store.get('split', 58));
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
    split.classList.add('drag');
    const move = (ev) => {
      const r = main.getBoundingClientRect();
      apply(((ev.clientY - r.top) / r.height) * 100);
      scheduleDraw();
    };
    const up = () => {
      document.body.classList.remove('dragging');
      split.classList.remove('drag');
      store.set('split', parseFloat(els.render.style.height));
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      buildRail();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
})();

// ---------------------------------------------------------------------
//  ヘッダー・通知
// ---------------------------------------------------------------------

function renderHeader() {
  const d = S.data;
  const on = $('#old-name'), nn = $('#new-name');
  on.textContent = d.old.name;
  on.title = d.old.path;
  nn.textContent = d.new.name;
  nn.title = d.new.path;
  if (d.old.name === d.new.name) {
    // 同名ファイルならフォルダ名も出して区別する
    const parent = (p) => p.split(/[\\/]/).slice(-2, -1)[0] || '';
    on.textContent = `${parent(d.old.path)}/${d.old.name}`;
    nn.textContent = `${parent(d.new.path)}/${d.new.name}`;
  }
  els.stats.innerHTML = `<span class="a">+${d.diff.ins}</span> <span class="d">−${d.diff.del}</span>`;
  document.title = `${d.old.name} → ${d.new.name} — HTML Diff`;
}

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.textContent = ''; }, 2500);
  els.live.classList.remove('flash');
  void els.live.offsetWidth;
  els.live.classList.add('flash');
}
function showError(msg) { els.error.textContent = msg; els.error.hidden = false; }
function hideError() { els.error.hidden = true; }

// ---------------------------------------------------------------------
//  ファイル監視（保存されたら自動更新）
// ---------------------------------------------------------------------

async function poll() {
  try {
    const r = await fetch('/api/version');
    const { version } = await r.json();
    els.live.classList.remove('off');
    els.live.textContent = '● LIVE';
    if (version !== S.version) await reload('file');
  } catch {
    els.live.classList.add('off');
    els.live.textContent = '● 切断';
  } finally {
    setTimeout(poll, 700);
  }
}

setMode(S.mode);
reload('init').then(() => setTimeout(poll, 700));
