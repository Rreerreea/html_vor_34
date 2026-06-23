// HTML to Figma (Free) — main thread
// Получает сериализованное дерево от UI и строит из него Figma-ноды.

figma.showUI(__html__, { width: 400, height: 510 });

// кредиты-кликер: грузим сохранённое значение при старте
(async () => {
  try {
    const c = await figma.clientStorage.getAsync('credits');
    figma.ui.postMessage({ type: 'credits', value: c || 0 });
  } catch (e) {}
})();

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'close') { figma.closePlugin(); return; }
  if (msg.type === 'saveCredits') { figma.clientStorage.setAsync('credits', msg.value).catch(() => {}); return; }
  if (msg.type === 'build') {
    try {
      await buildDesign(msg.data);
    } catch (e) {
      figma.ui.postMessage({ type: 'error', text: String(e && e.message || e) });
    }
  }
};

// ── helpers ────────────────────────────────────────────────────────────────

// "rgb(34, 34, 34)" / "rgba(0,0,0,.5)" → { r,g,b,a } в 0..1, либо null
function parseColor(str) {
  if (!str) return null;
  const m = str.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
  const [r, g, b] = parts;
  const a = parts.length > 3 ? parts[3] : 1;
  if (a === 0) return null; // полностью прозрачный — нет заливки
  return { r: r / 255, g: g / 255, b: b / 255, a };
}

function solidPaint(color) {
  return { type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a };
}

// base64 → Uint8Array
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Загрузка шрифтов с кешем и фоллбэком на Inter.
const fontCache = new Map();
function weightToStyle(weight, italic) {
  let w = parseInt(weight, 10);
  if (isNaN(w)) {
    const kw = String(weight).toLowerCase();
    w = (kw === 'bold' || kw === 'bolder') ? 700 : (kw === 'lighter' ? 300 : 400);
  }
  let style;
  if (w <= 100) style = 'Thin';
  else if (w <= 200) style = 'Extra Light';
  else if (w <= 300) style = 'Light';
  else if (w <= 400) style = 'Regular';
  else if (w <= 500) style = 'Medium';
  else if (w <= 600) style = 'Semi Bold';
  else if (w <= 700) style = 'Bold';
  else if (w <= 800) style = 'Extra Bold';
  else style = 'Black';
  if (italic) style = style === 'Regular' ? 'Italic' : style + ' Italic';
  return style;
}

async function ensureFont(family, weight, italic) {
  const interStyle = weightToStyle(weight, false); // Inter не имеет всех Italic-комбо
  const candidates = [
    { family: family, style: weightToStyle(weight, italic) },
    { family: family, style: weightToStyle(weight, false) },
    { family: family, style: 'Regular' },
    { family: 'Inter', style: interStyle },
    { family: 'Inter', style: 'Regular' }
  ];
  for (const f of candidates) {
    const key = f.family + '|' + f.style;
    if (fontCache.has(key)) {
      if (fontCache.get(key)) return f;
      continue;
    }
    try {
      await figma.loadFontAsync(f);
      fontCache.set(key, true);
      return f;
    } catch (e) {
      fontCache.set(key, false);
    }
  }
  const fallback = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(fallback);
  return fallback;
}

function applyCornerRadius(node, s) {
  const tl = parseFloat(s.borderTopLeftRadius) || 0;
  const tr = parseFloat(s.borderTopRightRadius) || 0;
  const br = parseFloat(s.borderBottomRightRadius) || 0;
  const bl = parseFloat(s.borderBottomLeftRadius) || 0;
  if (tl || tr || br || bl) {
    try {
      node.topLeftRadius = tl;
      node.topRightRadius = tr;
      node.bottomRightRadius = br;
      node.bottomLeftRadius = bl;
    } catch (e) {}
  }
}

function applyBorder(node, s) {
  const sides = [
    { w: parseFloat(s.borderTopWidth) || 0,    c: parseColor(s.borderTopColor),    st: s.borderTopStyle },
    { w: parseFloat(s.borderRightWidth) || 0,  c: parseColor(s.borderRightColor),  st: s.borderRightStyle },
    { w: parseFloat(s.borderBottomWidth) || 0, c: parseColor(s.borderBottomColor), st: s.borderBottomStyle },
    { w: parseFloat(s.borderLeftWidth) || 0,   c: parseColor(s.borderLeftColor),   st: s.borderLeftStyle }
  ];
  const isOn = (x) => x.w > 0 && x.c && x.st !== 'none';
  const active = sides.filter(isOn);
  if (!active.length) return;
  node.strokes = [solidPaint(active[0].c)]; // Figma: один цвет stroke на ноду — берём первую видимую
  node.strokeAlign = 'INSIDE';
  const uniform = active.length === 4 && sides.every((x) => x.w === active[0].w);
  if (uniform) {
    node.strokeWeight = active[0].w;
  } else {
    try {
      node.strokeTopWeight = isOn(sides[0]) ? sides[0].w : 0;
      node.strokeRightWeight = isOn(sides[1]) ? sides[1].w : 0;
      node.strokeBottomWeight = isOn(sides[2]) ? sides[2].w : 0;
      node.strokeLeftWeight = isOn(sides[3]) ? sides[3].w : 0;
    } catch (e) { node.strokeWeight = active[0].w; }
  }
}

// "rgba(0,0,0,.2) 0px 4px 12px 0px, ..." → drop/inner shadow effects (поддержка нескольких слоёв)
function applyShadow(node, boxShadow) {
  if (!boxShadow || boxShadow === 'none') return;
  // split по верхнеуровневым запятым (rgba(...) содержит запятые)
  const layers = []; let d = 0, buf = '';
  for (const ch of boxShadow) { if (ch === '(') d++; else if (ch === ')') d--; if (ch === ',' && d === 0) { layers.push(buf.trim()); buf = ''; } else buf += ch; }
  if (buf.trim()) layers.push(buf.trim());
  const effects = [];
  for (const layer of layers) {
    const colorMatch = layer.match(/rgba?\([^)]+\)/i);
    const color = colorMatch ? parseColor(colorMatch[0]) : { r: 0, g: 0, b: 0, a: 0.25 };
    if (!color) continue;
    const nums = layer.replace(/rgba?\([^)]+\)/i, '').match(/-?\d+\.?\d*px/g);
    if (!nums || nums.length < 2) continue;
    const p = nums.map((n) => parseFloat(n));
    const inset = /inset/i.test(layer);
    effects.push({
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { r: color.r, g: color.g, b: color.b, a: color.a },
      offset: { x: p[0] || 0, y: p[1] || 0 },
      radius: p[2] || 0,
      spread: p[3] || 0,
      visible: true,
      blendMode: 'NORMAL'
    });
  }
  if (effects.length) { try { node.effects = effects; } catch (e) {} }
}

function splitTopLevel(str) { let d = 0, buf = '', out = []; for (const ch of str) { if (ch === '(') d++; else if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(buf.trim()); buf = ''; } else buf += ch; } if (buf.trim()) out.push(buf.trim()); return out; }
function cssAngleToTransform(deg) { const a = deg * Math.PI / 180, cos = Math.sin(a), sin = -Math.cos(a); return [[cos, -sin, 0.5 - 0.5 * cos + 0.5 * sin], [sin, cos, 0.5 - 0.5 * sin - 0.5 * cos]]; }
function parseGradientPaint(bi) {
  if (!bi) return null;
  const isRad = /radial-gradient/i.test(bi); const isLin = /linear-gradient/i.test(bi);
  if (!isRad && !isLin) return null;
  let inner = bi.replace(/^.*?(?:linear|radial)-gradient\(/i, '').replace(/\)\s*$/, '');
  let parts = splitTopLevel(inner); let angle = 180;
  if (isLin) {
    const first = parts[0];
    if (/^(to\s|[\d.]+deg|[\d.]+turn|[\d.]+rad)/i.test(first) && !/rgba?\(/i.test(first)) {
      if (/deg/i.test(first)) angle = parseFloat(first);
      else if (/turn/i.test(first)) angle = parseFloat(first) * 360;
      else if (/rad/i.test(first)) angle = parseFloat(first) * 180 / Math.PI;
      else if (/to /i.test(first)) {
        const t = first.toLowerCase();
        if (t.includes('top') && t.includes('right')) angle = 45; else if (t.includes('bottom') && t.includes('right')) angle = 135;
        else if (t.includes('bottom') && t.includes('left')) angle = 225; else if (t.includes('top') && t.includes('left')) angle = 315;
        else if (t.includes('top')) angle = 0; else if (t.includes('right')) angle = 90; else if (t.includes('bottom')) angle = 180; else if (t.includes('left')) angle = 270;
      }
      parts = parts.slice(1);
    }
  } else { if (!/rgba?\(/i.test(parts[0])) parts = parts.slice(1); }
  const stops = [];
  parts.forEach((p) => {
    const cm = p.match(/(rgba?\([^)]+\)|#[0-9a-f]{3,8})/i);
    const col = cm ? parseColor(cm[0]) : null;
    let pos = null; const pm = p.match(/(-?[\d.]+)%/); if (pm) pos = parseFloat(pm[1]) / 100;
    stops.push({ col, pos });
  });
  const valid = stops.filter((s) => s.col);
  if (valid.length < 2) return null;
  valid.forEach((s, i) => { if (s.pos == null || isNaN(s.pos)) s.pos = valid.length > 1 ? i / (valid.length - 1) : 0; s.pos = Math.max(0, Math.min(1, s.pos)); });
  // Figma требует неубывающие позиции стопов
  const stopsOut = valid.map((s) => ({ position: s.pos, color: { r: s.col.r, g: s.col.g, b: s.col.b, a: s.col.a } }))
    .sort((a, b) => a.position - b.position);
  return {
    type: isRad ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR',
    gradientTransform: isRad ? [[1, 0, 0], [0, 1, 0]] : cssAngleToTransform(angle),
    gradientStops: stopsOut
  };
}

function applyBackground(node, n, images) {
  const fills = [];
  // картинка-фон (background-image: url или <img>)
  if (n.imageUrl && images[n.imageUrl]) {
    try {
      const img = figma.createImage(base64ToBytes(images[n.imageUrl]));
      let scaleMode = 'FILL';
      if (n.tag === 'img') {
        const of = (n.style.objectFit || 'fill');
        if (of === 'contain' || of === 'scale-down') scaleMode = 'FIT';
        else if (of === 'none') scaleMode = 'CROP';
        else scaleMode = 'FILL'; // cover, fill
      } else {
        const bs = (n.style.backgroundSize || '').trim();
        const rep = n.style.backgroundRepeat || '';
        if (bs === 'contain') scaleMode = 'FIT';
        else if (bs === 'cover') scaleMode = 'FILL';
        else if (rep && rep !== 'no-repeat' && /repeat/.test(rep)) scaleMode = 'TILE';
        else scaleMode = 'FILL';
      }
      const paint = { type: 'IMAGE', scaleMode: scaleMode, imageHash: img.hash };
      if (scaleMode === 'CROP') paint.imageTransform = [[1, 0, 0], [0, 1, 0]];
      if (scaleMode === 'TILE') paint.scalingFactor = 1;
      fills.push(paint);
    } catch (e) {}
  }
  // CSS-градиент как фон (если нет растровой картинки)
  if (!n.imageUrl && n.style.backgroundImage) {
    const g = parseGradientPaint(n.style.backgroundImage);
    if (g) fills.push(g);
  }
  // цвет фона (под картинкой/градиентом)
  const bg = parseColor(n.style.backgroundColor);
  if (bg) fills.unshift(solidPaint(bg));
  // кривой paint (напр. градиент) не должен ронять весь импорт
  try { node.fills = fills.length ? fills : []; }
  catch (e) {
    try { node.fills = bg ? [solidPaint(bg)] : []; } catch (e2) {}
  }
}

// ── Auto Layout: реконструкция CSS flexbox в нативный Figma Auto Layout ──────
function alJustify(jc) {
  switch ((jc || '').trim()) {
    case 'center': return 'CENTER';
    case 'flex-end': case 'end': case 'right': return 'MAX';
    case 'space-between': return 'SPACE_BETWEEN';
    case 'space-around': case 'space-evenly': return 'SPACE_BETWEEN'; // Figma не имеет around/evenly — ближайшее
    default: return 'MIN'; // flex-start / start / нормаль
  }
}
function alAlign(ai) {
  switch ((ai || '').trim()) {
    case 'center': return 'CENTER';
    case 'flex-end': case 'end': return 'MAX';
    case 'baseline': return 'BASELINE';
    default: return 'MIN'; // flex-start / stretch (stretch — через layoutAlign детей)
  }
}
// AL включаем только для flex, где дети образуют РОВНЫЙ поток (равные зазоры) —
// иначе (margin вразнобой, перекрытие, grid) абсолютные координаты точнее. Возвращает {mode, spacing} | null.
function decideAL(n) {
  const d = n.style.display;
  if (d !== 'flex' && d !== 'inline-flex') return null;
  const kids = (n.children || []).filter((c) => !(c.style && (c.style.position === 'absolute' || c.style.position === 'fixed')));
  if (!kids.length) return null;
  if ((n.style.flexWrap || '').indexOf('wrap') === 0) return null; // перенос — поток сложнее, не рискуем
  const mode = (n.style.flexDirection || 'row').indexOf('column') === 0 ? 'VERTICAL' : 'HORIZONTAL';
  const cssGap = mode === 'HORIZONTAL' ? (parseFloat(n.style.columnGap) || parseFloat(n.style.gap)) : (parseFloat(n.style.rowGap) || parseFloat(n.style.gap));
  let spacing = (cssGap && !isNaN(cssGap)) ? cssGap : null;
  if (spacing === null) {
    if (kids.length < 2) { spacing = 0; }
    else {
      const s = kids.slice().sort((a, b) => (mode === 'HORIZONTAL' ? a.x - b.x : a.y - b.y));
      const gaps = [];
      for (let i = 1; i < s.length; i++) {
        const p = s[i - 1], c = s[i];
        gaps.push(mode === 'HORIZONTAL' ? (c.x - (p.x + p.width)) : (c.y - (p.y + p.height)));
      }
      const min = Math.min.apply(null, gaps), max = Math.max.apply(null, gaps);
      if (min < -2) return null;       // дети перекрываются по главной оси — не чистый поток
      if (max - min > 6) return null;  // зазоры вразнобой (margin) — абсолют точнее
      spacing = Math.max(0, (min + max) / 2);
    }
  }
  return { mode: mode, spacing: spacing };
}
function applyAutoLayout(f, n, al) {
  try {
    const mode = al.mode;
    f.layoutMode = mode;
    f.itemSpacing = al.spacing || 0;
    f.paddingTop = parseFloat(n.style.paddingTop) || 0;
    f.paddingRight = parseFloat(n.style.paddingRight) || 0;
    f.paddingBottom = parseFloat(n.style.paddingBottom) || 0;
    f.paddingLeft = parseFloat(n.style.paddingLeft) || 0;
    f.primaryAxisAlignItems = alJustify(n.style.justifyContent);
    f.counterAxisAlignItems = alAlign(n.style.alignItems);
    // фиксируем размеры — фрейм должен совпасть с реальным, а не ужаться под контент
    f.primaryAxisSizingMode = 'FIXED';
    f.counterAxisSizingMode = 'FIXED';
    if ((n.style.flexWrap || '').indexOf('wrap') === 0) {
      try { f.layoutWrap = 'WRAP'; f.counterAxisSpacing = (mode === 'HORIZONTAL' ? rowGap : colGap) || 0; } catch (e) {}
    }
  } catch (e) {}
}
// поведение ребёнка внутри AL-родителя: absolute сохраняет координаты, flex-grow → FILL, stretch → STRETCH
function applyChildLayout(node, n, parentAL) {
  if (!parentAL) return;
  try {
    const pos = n.style && n.style.position;
    if (pos === 'absolute' || pos === 'fixed') { node.layoutPositioning = 'ABSOLUTE'; return; }
    if ((parseFloat(n.style && n.style.flexGrow) || 0) > 0) node.layoutGrow = 1;
    const selfStretch = n.style && n.style.alignSelf === 'stretch';
    const inheritStretch = parentAL.align === 'stretch' && (!n.style || !n.style.alignSelf || n.style.alignSelf === 'auto');
    if (selfStretch || inheritStretch) node.layoutAlign = 'STRETCH';
  } catch (e) {}
}

// ── build ────────────────────────────────────────────────────────────────

let importOffsetX = 0; // смещение для пачки: каждый следующий сайт встаёт правее

async function buildDesign(data) {
  const { tree, images, meta } = data;
  const svgs = data.svgs || {};
  if (!tree) throw new Error('пустое дерево');

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

  const root = figma.createFrame();
  root.name = meta.title || meta.url || 'Imported page';
  root.x = importOffsetX;
  root.y = 0;
  root.resize(Math.max(1, meta.width), Math.max(1, meta.height));
  root.clipsContent = true;
  const pageBg = parseColor(meta.backgroundColor) || { r: 1, g: 1, b: 1, a: 1 };
  root.fills = [solidPaint(pageBg)];

  let count = 0;
  const originX = tree.x;
  const originY = tree.y;

  async function buildNode(n, parent, parentX, parentY, parentAL) {
    // текстовая нода
    if (n.type === 'text') {
      const t = figma.createText();
      const font = await ensureFont(n.style.fontFamily, n.style.fontWeight, n.style.italic);
      t.fontName = font;
      t.fontSize = Math.max(1, parseFloat(n.style.fontSize) || 14);
      // переносы строк уже расставлены сервером по реальному раскладу на сайте,
      // поэтому ширину не фиксируем — иначе Inter перенёс бы заново и порвал слова
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
      t.characters = n.text;
      const ALIGN = { center: 'CENTER', right: 'RIGHT', end: 'RIGHT', justify: 'JUSTIFIED' };
      const ta = ALIGN[(n.style.textAlign || '').toLowerCase()];
      if (ta) { try { t.textAlignHorizontal = ta; } catch (e) {} }
      const TD = { underline: 'UNDERLINE', 'line-through': 'STRIKETHROUGH' };
      const td = TD[(n.style.textDecoration || '').split(' ')[0]];
      if (td) { try { t.textDecoration = td; } catch (e) {} }
      const col = parseColor(n.style.color);
      if (col) t.fills = [solidPaint(col)];
      const lh = parseFloat(n.style.lineHeight);
      if (lh && !isNaN(lh)) {
        try { t.lineHeight = { value: lh, unit: 'PIXELS' }; } catch (e) {}
      }
      const ls = parseFloat(n.style.letterSpacing);
      if (ls && !isNaN(ls)) {
        try { t.letterSpacing = { value: ls, unit: 'PIXELS' }; } catch (e) {}
      }
      t.x = n.x - parentX;
      t.y = n.y - parentY;
      parent.appendChild(t);
      applyChildLayout(t, n, parentAL);
      count++;
      return;
    }

    // inline SVG — векторная нода целиком
    if (n.svg) {
      try {
        const svgNode = figma.createNodeFromSvg(n.svg);
        svgNode.x = n.x - parentX;
        svgNode.y = n.y - parentY;
        try { svgNode.resize(Math.max(1, n.width), Math.max(1, n.height)); } catch (e) {}
        svgNode.name = n.name || 'svg';
        parent.appendChild(svgNode);
        applyChildLayout(svgNode, n, parentAL);
        count++;
        return;
      } catch (e) { /* кривой svg — падаем в обычный фрейм ниже */ }
    }

    // контейнер-фрейм
    const f = figma.createFrame();
    f.name = n.name || n.tag || 'div';
    f.x = n.x - parentX;
    f.y = n.y - parentY;
    f.resize(Math.max(1, n.width), Math.max(1, n.height));
    const clipsAxis = (v) => v === 'hidden' || v === 'clip' || v === 'auto' || v === 'scroll';
    f.clipsContent = clipsAxis(n.style.overflowX) || clipsAxis(n.style.overflowY);

    applyBackground(f, n, images);
    // картинка-источник оказалась SVG-файлом → векторная нода-фон
    if (n.imageUrl && svgs[n.imageUrl]) {
      try {
        const sv = figma.createNodeFromSvg(svgs[n.imageUrl]);
        sv.x = 0; sv.y = 0;
        try { sv.resize(Math.max(1, n.width), Math.max(1, n.height)); } catch (e) {}
        f.appendChild(sv);
        count++;
      } catch (e) {}
    }
    applyBorder(f, n.style);
    applyCornerRadius(f, n.style);
    applyShadow(f, n.style.boxShadow);
    const op = parseFloat(n.style.opacity);
    if (!isNaN(op) && op < 1) f.opacity = op;

    parent.appendChild(f);
    applyChildLayout(f, n, parentAL);
    count++;
    if (count % 25 === 0) figma.ui.postMessage({ type: 'progress', text: 'Построено нод: ' + count + '…' });

    // flex-контейнер → нативный Auto Layout (до построения детей)
    const myAL = decideAL(n);
    if (myAL) applyAutoLayout(f, n, myAL);

    const kids = (n.children || []).map((c, i) => ({ c, i }));
    if (myAL) {
      // порядок потока вдоль главной оси (absolute-дети вне потока — их порядок не важен)
      kids.sort((a, b) => (myAL.mode === 'HORIZONTAL' ? a.c.x - b.c.x : a.c.y - b.c.y));
    } else {
      kids.sort((a, b) => {
        const za = (a.c.style && a.c.style.position && a.c.style.position !== 'static') ? (parseInt(a.c.style.zIndex, 10) || 0) : 0;
        const zb = (b.c.style && b.c.style.position && b.c.style.position !== 'static') ? (parseInt(b.c.style.zIndex, 10) || 0) : 0;
        if (za !== zb) return za - zb;
        return a.i - b.i;
      });
    }
    const childAL = myAL ? { mode: myAL.mode, align: n.style.alignItems } : null;
    for (const k of kids) { await buildNode(k.c, f, n.x, n.y, childAL); }
  }

  // строим детей корня прямо в root, чтобы не плодить лишний внешний фрейм
  for (const child of tree.children || []) {
    await buildNode(child, root, originX, originY);
  }

  figma.currentPage.appendChild(root);
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  importOffsetX += root.width + 120; // следующий сайт пачки — правее
  figma.ui.postMessage({ type: 'done', text: 'Готово! Построено нод: ' + count });
}
