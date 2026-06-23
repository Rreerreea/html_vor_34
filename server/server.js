// HTML to Figma (Free) — local capture server
// Рендерит страницу в headless Chromium, сериализует DOM + computed styles,
// скачивает картинки и отдаёт плагину единым JSON.

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const sharp = require('sharp');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');

const PORT = process.env.PORT || 3789;
const MAX_NODES = 4000;                                  // защита от гигантских страниц
const RATE_MAX = parseInt(process.env.RATE_MAX || '20', 10);     // запросов /capture с одного IP в минуту
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10); // одновременных рендеров (RAM-лимит)

const app = express();
app.set('trust proxy', true); // за nginx — реальный IP в x-forwarded-for
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/music', express.static(path.join(__dirname, 'music'))); // локальные аудиофайлы пользователя для плеера

// ── SSRF-защита: не давать рендерить приватные/служебные адреса ──────────────
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;            // link-local + cloud metadata (169.254.169.254)
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127') || l.startsWith('::ffff:10');
}
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('некорректный URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('разрешены только http/https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new Error('приватный хост запрещён');
  }
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('приватный IP запрещён'); return; }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw new Error('не удалось разрешить хост'); }
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('хост резолвится в приватный адрес');
}

// ── rate-limit по IP (in-memory, скользящее окно 60с) ──────────────────────
const rlHits = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 60000;
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  rlHits.set(ip, arr);
  return arr.length > RATE_MAX;
}
setInterval(() => { const now = Date.now(); for (const [ip, arr] of rlHits) { const f = arr.filter((t) => now - t < 60000); if (f.length) rlHits.set(ip, f); else rlHits.delete(ip); } }, 120000).unref();

let activeCaptures = 0; // лимит одновременных рендеров против OOM

let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch();
  }
  return browser;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// обратная связь из плагина → пересылка автору в Telegram (TG_TOKEN/TG_CHAT в env)
app.post('/feedback', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  if (rateLimited('fb:' + ip)) return res.status(429).json({ error: 'слишком часто' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 1500);
  const url = String((req.body && req.body.url) || '').slice(0, 300);
  if (!text) return res.status(400).json({ error: 'пустое сообщение' });
  const msg = '🐞 html_vor_34 feedback:\n' + text + (url ? '\n\nстраница: ' + url : '') + '\n\nip: ' + ip;
  const TG = process.env.TG_TOKEN, CHAT = process.env.TG_CHAT;
  let delivered = false;
  if (TG && CHAT) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + TG + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT, text: msg })
      });
      delivered = r.ok;
    } catch (e) { /* сеть — ниже залогируем */ }
  }
  console.log('[feedback]' + (delivered ? ' →TG' : ' (no TG env, only log)') + '\n' + msg);
  res.json({ ok: true });
});

app.post('/capture', async (req, res) => {
  let { url, width = 1440 } = req.body || {};
  if (!url) return res.status(400).json({ error: 'no url' });
  url = String(url).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url; // hicebank.ru/new → https://hicebank.ru/new

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'слишком много запросов, подождите минуту' });
  try { await assertPublicUrl(url); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (activeCaptures >= MAX_CONCURRENT) return res.status(503).json({ error: 'сервер занят рендером, повторите через пару секунд' });
  activeCaptures++;

  let context, page;
  const t0 = Date.now();
  try {
    const b = await getBrowser();
    context = await b.newContext({
      viewport: { width: Math.round(width), height: 900 },
      deviceScaleFactor: 2,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
    await gotoResilient(page, url);

    // глушим анимации/переходы: reveal-эффекты доезжают до конечного кадра мгновенно,
    // а бесконечные карусели не застывают в полупрозрачном промежуточном состоянии
    await page.addStyleTag({
      content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;}'
    }).catch(() => {});

    await autoScroll(page);
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));

    const result = await page.evaluate(serializePage, MAX_NODES);

    // собрать уникальные растровые картинки
    const urls = new Set();
    (function collect(n) {
      if (!n) return;
      if (n.imageUrl) urls.add(n.imageUrl);
      (n.children || []).forEach(collect);
    })(result.tree);

    const images = {}; // url → base64 (растровые: PNG/JPG/GIF/WEBP)
    const svgs = {};   // url → svg-текст (createImage их не ест, строим как вектор)
    const looksSvg = (head, ct) =>
      ct.includes('svg') || /^\s*<\?xml/.test(head) || head.includes('<svg');

    // url → {w,h} максимального бокса отображения (для адаптивного потолка ресайза)
    const boxByUrl = new Map();
    (function measure(n) {
      if (!n) return;
      if (n.imageUrl) {
        const b = boxByUrl.get(n.imageUrl) || { w: 0, h: 0 };
        b.w = Math.max(b.w, n.width || 0);
        b.h = Math.max(b.h, n.height || 0);
        boxByUrl.set(n.imageUrl, b);
      }
      (n.children || []).forEach(measure);
    })(result.tree);

    // Ресайз под реальный бокс отображения (×1.5) + пережатие в JPEG q78 — режет вес ответа для передачи.
    // Figma всё равно не рендерит fill со стороной > 4096px. Прозрачные → PNG (с палитрой), остальное → JPEG.
    const FIGMA_MAX = 4096;
    async function normalizeRaster(buf, box) {
      let meta;
      try { meta = await sharp(buf, { failOn: 'none' }).metadata(); }
      catch (e) { return buf.toString('base64'); } // не картинка для sharp — отдаём как есть
      const longest = Math.max(meta.width || 0, meta.height || 0);
      const want = box ? Math.min(FIGMA_MAX, Math.max(64, Math.ceil(Math.max(box.w, box.h) * 1.5))) : FIGMA_MAX;
      try {
        let pipe = sharp(buf, { failOn: 'none', animated: false });
        if (longest > want) pipe = pipe.resize({ width: want, height: want, withoutEnlargement: true, fit: 'inside' });
        const out = meta.hasAlpha
          ? await pipe.png({ compressionLevel: 9, palette: true }).toBuffer()
          : await pipe.jpeg({ quality: 78, mozjpeg: true }).toBuffer();
        return out.toString('base64');
      } catch (e) { return buf.toString('base64'); }
    }

    const pageOrigin = (() => { try { return new URL(url).origin + '/'; } catch (e) { return undefined; } })();
    const imgHeaders = {
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    };
    if (pageOrigin) imgHeaders['Referer'] = pageOrigin;

    async function fetchOne(u) {
      if (u.startsWith('shot:')) return; // снимается скриншотом рендера ниже
      if (u.startsWith('data:')) {
        const comma = u.indexOf(',');
        if (comma === -1) return;
        const payload = u.slice(comma + 1);
        if (/^data:image\/svg\+xml/i.test(u)) {
          svgs[u] = /;base64/i.test(u.slice(0, comma))
            ? Buffer.from(payload, 'base64').toString('utf8')
            : decodeURIComponent(payload);
        } else {
          const raw = /;base64/i.test(u.slice(0, comma))
            ? Buffer.from(payload, 'base64')
            : Buffer.from(decodeURIComponent(payload), 'binary');
          images[u] = await normalizeRaster(raw, boxByUrl.get(u));
        }
        return;
      }
      const attempts = 3;
      for (let i = 0; i < attempts; i++) {
        try {
          const r = await context.request.get(u, { timeout: 30000, headers: imgHeaders });
          if (r.ok()) {
            const buf = await r.body();
            const ct = (r.headers()['content-type'] || '').toLowerCase();
            if (looksSvg(buf.slice(0, 256).toString('utf8'), ct)) svgs[u] = buf.toString('utf8');
            else images[u] = await normalizeRaster(buf, boxByUrl.get(u));
            return;
          }
          if (r.status() < 500 && r.status() !== 429) { console.warn('img ' + r.status() + ': ' + u.slice(0, 120)); return; }
        } catch (e) { /* таймаут/сеть — ретраим */ }
        if (i < attempts - 1) await new Promise((res) => setTimeout(res, 400 * (i + 1)));
      }
      console.warn('img failed after ' + attempts + ' tries: ' + u.slice(0, 120));
    }

    const queue = [...urls];
    const LIMIT = 8;
    await Promise.all(Array.from({ length: Math.min(LIMIT, queue.length) }, async () => {
      while (queue.length) { const u = queue.shift(); if (u) await fetchOne(u); }
    }));

    // video без постера / tainted canvas — снимаем скриншот их реального рендера на странице
    if (result.shotCount > 0) {
      await page.waitForTimeout(300); // дать видео отрисовать кадр
      try {
        const shotEls = await page.$$('[data-h2f-shot]');
        for (const h of shotEls) {
          const id = await h.getAttribute('data-h2f-shot');
          try {
            const buf = await h.screenshot({ type: 'jpeg', quality: 85, timeout: 8000, animations: 'disabled' });
            images['shot:' + id] = await normalizeRaster(buf, boxByUrl.get('shot:' + id));
          } catch (e) { /* элемент вне потока/нулевой — пропускаем */ }
        }
      } catch (e) { /* нет помеченных — норм */ }
    }

    console.log(
      `captured ${url} — ${result.meta.nodeCountRaw}→${result.meta.nodeCount} nodes (clean), ` +
      `${Object.keys(images).length} raster, ${Object.keys(svgs).length} svg, ${Date.now() - t0}ms` +
      `${result.meta.truncated ? ' ⚠ TRUNCATED at ' + MAX_NODES : ''}`
    );
    res.json({ tree: result.tree, images, svgs, meta: result.meta });
  } catch (e) {
    console.error('capture error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    activeCaptures--;
  }
});

// Устойчивая навигация: domcontentloaded (networkidle на тяжёлых сайтах виснет),
// ретраи на «interrupted by another navigation»/сетевые сбои, проверка реальной загрузки.
async function gotoResilient(page, url) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const cur = page.url();
      if (cur.startsWith('chrome-error://')) throw new Error('страница не загрузилась (сетевая ошибка)');
      if (resp && resp.status() >= 400) throw new Error('сайт вернул HTTP ' + resp.status());
      // дать догрузиться динамике, но НЕ висеть на networkidle
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(700 * (i + 1)); // даём странице устаканиться и пробуем снова
    }
  }
  throw new Error('не удалось открыть ' + url + ' — ' + (lastErr && lastErr.message || lastErr));
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 600;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight + 1000) {
          clearInterval(timer);
          resolve();
        }
      }, 60);
    });
  });
}

// ── выполняется ВНУТРИ браузера ────────────────────────────────────────────
// Должна быть полностью самодостаточной (никаких внешних ссылок).
function serializePage(maxNodes) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TITLE', 'BR', 'TEMPLATE']);
  let count = 0;
  let shotCount = 0; // элементы под server-side скриншот (video без постера, tainted canvas)
  const placedTexts = []; // занятые текстом bbox — против наложенных кадров анимаций

  function textOverlaps(a) {
    for (const b of placedTexts) {
      const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      const minArea = Math.min(a.width * a.height, b.width * b.height);
      if (minArea > 0 && (ox * oy) / minArea > 0.6) return true;
    }
    return false;
  }

  function isVisible(el, s) {
    if (!s) return false;
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    // фактическая видимость с учётом накопленной opacity предков —
    // отсекает скрытые слои анимаций (напр. варианты слов в анимированном заголовке)
    if (el.checkVisibility &&
        !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) {
      return false;
    }
    if (parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < -2000 || r.right < -2000) return false;
    return true;
  }

  function abs(rect) {
    return {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height
    };
  }

  function pick(s) {
    return {
      backgroundColor: s.backgroundColor,
      backgroundSize: s.backgroundSize,
      backgroundRepeat: s.backgroundRepeat,
      // чистый CSS-градиент (без url) — для GradientPaint в плагине
      backgroundImage: (s.backgroundImage && s.backgroundImage.indexOf('gradient') !== -1 && s.backgroundImage.indexOf('url(') === -1) ? s.backgroundImage : '',
      objectFit: s.objectFit,
      color: s.color,
      fontFamily: (s.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      italic: s.fontStyle === 'italic',
      lineHeight: s.lineHeight === 'normal' ? '' : s.lineHeight,
      letterSpacing: s.letterSpacing === 'normal' ? '' : s.letterSpacing,
      textAlign: s.textAlign,
      opacity: s.opacity,
      // flexbox — для реконструкции Auto Layout в плагине
      display: s.display,
      flexDirection: s.flexDirection,
      flexWrap: s.flexWrap,
      justifyContent: s.justifyContent,
      alignItems: s.alignItems,
      alignSelf: s.alignSelf,
      flexGrow: s.flexGrow,
      columnGap: s.columnGap,
      rowGap: s.rowGap,
      gap: s.gap,
      paddingTop: s.paddingTop,
      paddingRight: s.paddingRight,
      paddingBottom: s.paddingBottom,
      paddingLeft: s.paddingLeft,
      // axis-aware overflow (computed всегда нормализован в одно значение на ось)
      overflowX: s.overflowX,
      overflowY: s.overflowY,
      position: s.position,
      zIndex: s.zIndex,
      borderTopWidth: s.borderTopWidth,
      borderTopColor: s.borderTopColor,
      borderTopStyle: s.borderTopStyle,
      borderRightWidth: s.borderRightWidth,
      borderRightColor: s.borderRightColor,
      borderRightStyle: s.borderRightStyle,
      borderBottomWidth: s.borderBottomWidth,
      borderBottomColor: s.borderBottomColor,
      borderBottomStyle: s.borderBottomStyle,
      borderLeftWidth: s.borderLeftWidth,
      borderLeftColor: s.borderLeftColor,
      borderLeftStyle: s.borderLeftStyle,
      borderTopLeftRadius: s.borderTopLeftRadius,
      borderTopRightRadius: s.borderTopRightRadius,
      borderBottomRightRadius: s.borderBottomRightRadius,
      borderBottomLeftRadius: s.borderBottomLeftRadius,
      boxShadow: s.boxShadow
    };
  }

  // прямой текст элемента + его bounding box через Range
  // Измеряем, как текст реально ломается на строки в браузере, и вставляем
  // переносы явно. Так результат не зависит от подмены шрифта в Figma
  // (иначе Inter шире фирменного шрифта и рвёт слова не там).
  function directText(el) {
    const tns = [];
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim()) tns.push(node);
    }
    if (!tns.length) return null;

    const tt = getComputedStyle(el).textTransform;
    const xform = (str) => {
      if (tt === 'uppercase') return str.toUpperCase();
      if (tt === 'lowercase') return str.toLowerCase();
      if (tt === 'capitalize') return str.replace(/(^|\s)([^\s])/g, (m, a, b) => a + b.toUpperCase());
      return str;
    };

    const TOL = 5; // допуск по вертикали, px — слова одной строки
    const lines = [];
    for (const tn of tns) {
      const parts = tn.textContent.split(/(\s+)/); // слова + пробелы
      let off = 0;
      for (const part of parts) {
        const len = part.length;
        if (!part.trim()) { off += len; continue; }
        let r;
        try {
          const range = document.createRange();
          range.setStart(tn, off);
          range.setEnd(tn, off + len);
          r = range.getBoundingClientRect();
        } catch (e) { off += len; continue; }
        off += len;
        if (r.width === 0 && r.height === 0) continue;
        let line = null;
        for (const L of lines) { if (Math.abs(L.top - r.top) <= TOL) { line = L; break; } }
        if (!line) { line = { top: r.top, bottom: r.bottom, left: r.left, right: r.right, words: [] }; lines.push(line); }
        line.words.push(part);
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
      }
    }
    if (!lines.length) return null;
    lines.sort((a, b) => a.top - b.top);
    const text = lines.map((L) => xform(L.words.join(' ').replace(/\s+/g, ' ').trim())).filter(Boolean).join('\n');
    if (!text) return null;
    const left = Math.min.apply(null, lines.map((L) => L.left));
    const top = Math.min.apply(null, lines.map((L) => L.top));
    const right = Math.max.apply(null, lines.map((L) => L.right));
    const bottom = Math.max.apply(null, lines.map((L) => L.bottom));
    return { text, rect: { left, top, width: right - left, height: bottom - top } };
  }

  function bgImageUrl(s) {
    const bg = s.backgroundImage;
    if (!bg || bg === 'none' || bg.indexOf('url(') === -1) return null;
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/i);
    if (!m) return null;
    try { return new URL(m[1], location.href).href; } catch (e) { return null; }
  }

  let truncated = false;
  // ── чистка дерева: имена слоёв + схлопывание пустых обёрток ──
  // семантические теги сохраняем как именованные слои даже без визуала
  const KEEP = new Set(['header','nav','main','section','article','footer','aside','form',
    'button','a','ul','ol','li','figure','figcaption','label','table','thead','tbody','tr','td','th',
    'h1','h2','h3','h4','h5','h6','img','svg','video','canvas','input','textarea','select']);

  const cleanLabel = (s) => (s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  function nameFor(el, tag) {
    const aria = cleanLabel(el.getAttribute && el.getAttribute('aria-label'));
    if (aria) return aria.slice(0, 40);
    if (tag === 'img') { const alt = cleanLabel(el.getAttribute('alt')); return alt ? 'img: ' + alt.slice(0, 30) : 'image'; }
    if (tag === 'a' || tag === 'button') {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return (tag === 'a' ? 'link' : 'button') + (t ? ': ' + t.slice(0, 24) : '');
    }
    if (['header','nav','main','section','article','footer','aside','form','ul','ol','li','figure','table',
         'h1','h2','h3','h4','h5','h6','video','canvas','input','textarea','select'].includes(tag)) return tag;
    const role = el.getAttribute && el.getAttribute('role');
    if (role) return role;
    return tag;
  }

  function opaqueColor(c) {
    if (!c || c === 'transparent') return false;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return (p.length > 3 ? p[3] : 1) > 0;
  }
  function hasVisual(n) {
    if (n.imageUrl || n.svg) return true;
    const s = n.style;
    if (opaqueColor(s.backgroundColor)) return true;
    if (s.backgroundImage) return true; // градиент (pick кладёт только чистый градиент)
    const W = ['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'];
    const ST = ['borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle'];
    for (let i = 0; i < 4; i++) { if ((parseFloat(s[W[i]]) || 0) > 0 && s[ST[i]] !== 'none') return true; }
    if (s.boxShadow && s.boxShadow !== 'none') return true;
    return false;
  }
  function clipsNode(n) {
    const c = (v) => v === 'hidden' || v === 'clip' || v === 'auto' || v === 'scroll';
    return c(n.style.overflowX) || c(n.style.overflowY);
  }
  // «немая» обёртка: неструктурный тег без визуала, обрезки и групповой прозрачности
  function isTransparentWrapper(n) {
    if (n.type !== 'element' || KEEP.has(n.tag)) return false;
    if (hasVisual(n) || clipsNode(n)) return false;
    if ((parseFloat(n.style.opacity) || 1) < 1) return false;
    return true;
  }
  // снизу вверх: разворачиваем пустые обёртки в их детей, удаляем пустышки
  function collapse(node) {
    if (!node || node.type === 'text') return node;
    const kids = [];
    for (const c of (node.children || [])) {
      const r = collapse(c);
      if (!r) continue;
      if (Array.isArray(r)) Array.prototype.push.apply(kids, r); else kids.push(r);
    }
    node.children = kids;
    if (isTransparentWrapper(node)) return kids.length ? kids : null;
    return node;
  }

  function walk(el) {
    if (count >= maxNodes) { truncated = true; return null; }
    if (el.nodeType !== 1 || SKIP.has(el.tagName)) return null;
    const s = getComputedStyle(el);
    if (!isVisible(el, s)) return null;

    const tag = el.tagName.toLowerCase();
    const r = abs(el.getBoundingClientRect());
    count++;

    const node = { type: 'element', tag, name: nameFor(el, tag), x: r.x, y: r.y, width: r.width, height: r.height, style: pick(s), children: [] };

    // inline SVG — снимаем как векторную ноду целиком
    if (tag === 'svg') {
      node.svg = el.outerHTML;
      return node;
    }

    // растровые картинки
    if (tag === 'img') {
      let src = el.currentSrc || el.src;
      const looksPlaceholder = !src || (/^data:/.test(src) && src.length < 256) || (el.naturalWidth <= 1 && el.naturalHeight <= 1);
      if (looksPlaceholder) {
        const ds = el.getAttribute('data-srcset') || el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('data-lazy-src') || '';
        if (ds) { const cand = ds.split(',').pop().trim().split(/\s+/)[0]; if (cand) src = cand; }
      }
      if (src && !(/^data:/.test(src) && src.length < 256)) {
        try { node.imageUrl = new URL(src, location.href).href; } catch (e) {}
      }
      return node; // у img нет значимых детей
    }

    // помечаем элемент под server-side скриншот его рендера (надёжно, не зависит от CORS)
    function markForShot() {
      node.shotId = ++shotCount;
      try { el.setAttribute('data-h2f-shot', String(node.shotId)); } catch (e) {}
      node.imageUrl = 'shot:' + node.shotId;
    }

    if (tag === 'video') {
      let done = false;
      if (el.poster) { try { node.imageUrl = new URL(el.poster, location.href).href; done = true; } catch (e) {} }
      if (!done) {
        // 1) пробуем текущий кадр видео через canvas (если CORS позволяет)
        try {
          const c = document.createElement('canvas');
          c.width = el.videoWidth || Math.round(r.width);
          c.height = el.videoHeight || Math.round(r.height);
          if (c.width > 1 && c.height > 1) {
            c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
            const u = c.toDataURL('image/jpeg', 0.85); // кадр видео = фото → JPEG (PNG тут раздувает в разы)
            if (u && u.length > 256) { node.imageUrl = u; done = true; }
          }
        } catch (e) { /* tainted/cross-origin — пойдём через скриншот рендера */ }
      }
      if (!done) markForShot(); // 2) скриншот элемента на сервере
      return node;
    }
    if (tag === 'canvas') {
      try {
        const u = el.toDataURL('image/png');
        if (u && u.length > 256) node.imageUrl = u; else markForShot();
      } catch (e) { markForShot(); } // tainted canvas → скриншот рендера
      return node;
    }

    // поля форм хранят текст в .value/.placeholder/.selectedOptions, не в DOM-тексте
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      let val = '';
      if (tag === 'select') {
        const o = el.selectedOptions && el.selectedOptions[0];
        val = o ? o.textContent.trim() : '';
      } else {
        const type = (el.type || '').toLowerCase();
        if (type === 'password') val = el.value ? '••••••••' : (el.placeholder || '');
        else if (type !== 'hidden' && type !== 'file') val = el.value || el.placeholder || '';
      }
      if (val) {
        const fsz = parseFloat(s.fontSize) || 14;
        node.children.push({
          type: 'text', text: val,
          x: r.x + 8, y: r.y + Math.max(0, (r.height - fsz * 1.2) / 2),
          width: Math.max(1, r.width - 16), height: fsz,
          style: {
            color: el.value ? s.color : 'rgb(150,150,150)',
            fontFamily: (s.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
            fontSize: s.fontSize, fontWeight: s.fontWeight,
            italic: s.fontStyle === 'italic',
            lineHeight: s.lineHeight === 'normal' ? '' : s.lineHeight,
            letterSpacing: s.letterSpacing === 'normal' ? '' : s.letterSpacing,
            textAlign: s.textAlign
          }
        });
      }
      return node;
    }

    const bgUrl = bgImageUrl(s);
    if (bgUrl) node.imageUrl = bgUrl;

    // прямой текст → отдельная text-нода (до детей, чтобы порядок был естественным)
    const dt = directText(el);
    const tr = dt ? abs(dt.rect) : null;
    if (dt && !textOverlaps(tr)) { // наложенный кадр анимации — текст пропускаем, детей оставляем
      placedTexts.push(tr);
      node.children.push({
        type: 'text',
        text: dt.text,
        x: tr.x, y: tr.y, width: tr.width, height: tr.height,
        style: {
          color: s.color,
          fontFamily: (s.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          italic: s.fontStyle === 'italic',
          lineHeight: s.lineHeight === 'normal' ? '' : s.lineHeight,
          letterSpacing: s.letterSpacing === 'normal' ? '' : s.letterSpacing,
          textAlign: s.textAlign,
          textDecoration: s.textDecorationLine
        }
      });
    }

    for (const child of el.children) {
      const c = walk(child);
      if (c) node.children.push(c);
    }
    return node;
  }

  const tree = walk(document.body) || { type: 'element', tag: 'body', name: 'body', x: 0, y: 0, width: 0, height: 0, style: {}, children: [] };

  let rawCount = 0;
  (function cnt(n) { if (!n) return; rawCount++; (n.children || []).forEach(cnt); })(tree);

  // схлопываем пустые обёртки в детях корня (сам корень не разворачиваем)
  const cleanedKids = [];
  for (const c of (tree.children || [])) {
    const r = collapse(c);
    if (!r) continue;
    if (Array.isArray(r)) Array.prototype.push.apply(cleanedKids, r); else cleanedKids.push(r);
  }
  tree.children = cleanedKids;
  let cleanCount = 0;
  (function cnt(n) { if (!n) return; cleanCount++; (n.children || []).forEach(cnt); })(tree);

  let pageBg = getComputedStyle(document.body).backgroundColor;
  if (!pageBg || pageBg === 'rgba(0, 0, 0, 0)' || pageBg === 'transparent') {
    pageBg = getComputedStyle(document.documentElement).backgroundColor;
  }
  if (!pageBg || pageBg === 'rgba(0, 0, 0, 0)' || pageBg === 'transparent') pageBg = 'rgb(255,255,255)';

  return {
    tree,
    count,
    shotCount,
    meta: {
      url: location.href,
      title: document.title,
      width: Math.round(window.innerWidth),
      height: Math.round(document.documentElement.scrollHeight),
      backgroundColor: pageBg,
      nodeCount: cleanCount,
      nodeCountRaw: rawCount,
      maxNodes: maxNodes,
      truncated: truncated
    }
  };
}

app.listen(PORT, () => {
  console.log(`\n  HTML→Figma capture server → http://localhost:${PORT}`);
  console.log('  Жду запросы от плагина. Ctrl+C для остановки.\n');
});
