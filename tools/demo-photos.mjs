// Synthetic, photo-like demo images for the screenshots.
// Deterministic per id, pure SVG (no third-party photos). Uses fractal noise for
// clouds, water ripples and film grain, atmospheric perspective and reflections.
//
// renderScene({ theme, roof?, dome?, brick?, peaky? }, id, px) -> SVG string
// themes: beach | island | city | canal | alpine | fjord

const V = 240; // viewBox size

function rng(seed) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const n1 = (v) => v.toFixed(1);
const n3 = (v) => v.toFixed(3);
const hsl = (h, s, l) => `hsl(${n1(h)},${n1(s)}%,${n1(l)}%)`;

const SKIES = {
  day: { top: [212, 62, 42], bottom: [200, 58, 82], sun: '#fffbe8', cloud: [1, 1, 1], haze: [205, 35, 80], cloudOpacity: 0.85 },
  golden: { top: [26, 62, 52], bottom: [40, 88, 76], sun: '#fff1c2', cloud: [1, 0.88, 0.72], haze: [32, 55, 76], cloudOpacity: 0.7 },
  dusk: { top: [258, 36, 26], bottom: [16, 76, 64], sun: '#ffd6a8', cloud: [1, 0.74, 0.76], haze: [320, 28, 58], cloudOpacity: 0.6 },
  night: { top: [232, 60, 7], bottom: [236, 32, 26], sun: '#f4f1e6', cloud: [0.55, 0.6, 0.78], haze: [236, 22, 30], cloudOpacity: 0.25 },
};

/** Time of day, weighted. Night only where lit windows make sense. */
function timeOfDay(r, allowNight) {
  const x = r();
  if (x < 0.55) return 'day';
  if (x < 0.8) return 'golden';
  if (x < 0.92 || !allowNight) return 'dusk';
  return 'night';
}

function sky(r, tod, seed, horizon) {
  const s = SKIES[tod];
  const jitter = (c, d) => [c[0] + (r() - 0.5) * d, c[1], c[2] + (r() - 0.5) * d];
  const top = jitter(s.top, 8);
  const bottom = jitter(s.bottom, 8);
  const sunX = 30 + r() * 180;
  const sunY = tod === 'day' ? 22 + r() * 40 : horizon - 18 - r() * 30;
  const [cr, cg, cb] = s.cloud;
  const defs = `
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hsl(...top)}"/><stop offset="1" stop-color="${hsl(...bottom)}"/>
    </linearGradient>
    <radialGradient id="sunGlow">
      <stop offset="0" stop-color="${s.sun}" stop-opacity="0.95"/>
      <stop offset="0.22" stop-color="${s.sun}" stop-opacity="0.5"/>
      <stop offset="1" stop-color="${s.sun}" stop-opacity="0"/>
    </radialGradient>
    <filter id="clouds" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="${n3(0.007 + r() * 0.006)} ${n3(0.028 + r() * 0.02)}" numOctaves="5" seed="${seed % 997}"/>
      <feColorMatrix type="matrix" values="0 0 0 0 ${cr}  0 0 0 0 ${cg}  0 0 0 0 ${cb}  ${n3(2.6 + r())} 0 0 0 ${n3(-1.3 - r() * 0.35)}"/>
    </filter>`;
  let body = `<rect width="${V}" height="${V}" fill="url(#sky)"/>`;
  if (tod === 'night') {
    for (let i = 0; i < 40; i++) {
      body += `<circle cx="${n1(r() * V)}" cy="${n1(r() * horizon * 0.8)}" r="${n1(0.3 + r() * 0.7)}" fill="#fff" opacity="${n1(0.4 + r() * 0.6)}"/>`;
    }
    const moonY = 20 + r() * 30;
    body += `<circle cx="${n1(sunX)}" cy="${n1(moonY)}" r="22" fill="url(#sunGlow)" opacity="0.5"/>`
      + `<circle cx="${n1(sunX)}" cy="${n1(moonY)}" r="6" fill="${s.sun}"/>`;
  } else {
    body += `<circle cx="${n1(sunX)}" cy="${n1(sunY)}" r="48" fill="url(#sunGlow)"/>`
      + `<circle cx="${n1(sunX)}" cy="${n1(sunY)}" r="${n1(6 + r() * 3)}" fill="${s.sun}"/>`;
  }
  body += `<rect width="${V}" height="${n1(horizon)}" filter="url(#clouds)" opacity="${s.cloudOpacity}"/>`;
  return { defs, body, sunX, sunY, haze: s.haze, sunColor: s.sun };
}

function finish(seed) {
  return {
    defs: `
      <filter id="grain" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${seed % 991}" stitchTiles="stitch"/>
        <feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1"/>
      </filter>
      <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
        <stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/>
      </radialGradient>`,
    body: `<rect width="${V}" height="${V}" filter="url(#grain)" opacity="0.3" style="mix-blend-mode:overlay"/>`
      + `<rect width="${V}" height="${V}" fill="url(#vignette)"/>`,
  };
}

/** Shared water defs: ripple displacement + clip for everything below the waterline. */
function waterDefs(seed, waterY) {
  return `
    <filter id="ripple" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.01 0.14" numOctaves="2" seed="${seed % 983}" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G"/>
      <feGaussianBlur stdDeviation="1.1"/>
    </filter>
    <clipPath id="below"><rect y="${n1(waterY)}" width="${V}" height="${n1(V - waterY)}"/></clipPath>`;
}
const reflection = (id, waterY, opacity = 0.5) =>
  `<g clip-path="url(#below)"><use href="#${id}" transform="matrix(1 0 0 -1 0 ${n1(2 * waterY)})" opacity="${opacity}" filter="url(#ripple)"/></g>`;

/** Midpoint-displacement ridge, closed to the bottom (or, for snow clips, the top) of the image. */
function ridge(r, yL, yR, disp, depth = 6, x0 = -6, x1 = V + 6, toTop = false) {
  const pts = [];
  const step = (xa, xb, ya, yb, d, k) => {
    if (k === 0) { pts.push([xa, ya]); return; }
    const xm = (xa + xb) / 2;
    const ym = (ya + yb) / 2 + (r() - 0.5) * d;
    step(xa, xm, ya, ym, d * 0.55, k - 1);
    step(xm, xb, ym, yb, d * 0.55, k - 1);
  };
  step(x0, x1, yL, yR, disp, depth);
  pts.push([x1, yR]);
  const edgeY = toTop ? 0 : V;
  return `M${pts.map(([x, y]) => `${n1(x)} ${n1(y)}`).join('L')}L${x1} ${edgeY}L${x0} ${edgeY}Z`;
}

/** Clip region above a jagged snow line. */
const snowClip = (r, id, y) => `<clipPath id="${id}"><path d="${ridge(r, y, y, 26, 5, -6, V + 6, true)}"/></clipPath>`;

function pine(x, base, h, color) {
  const w = h * 0.42;
  let d = '';
  for (let i = 0; i < 3; i++) {
    const top = base - h + i * h * 0.22;
    const bot = base - h * 0.25 + i * h * 0.12;
    const ww = w * (0.55 + i * 0.25);
    d += `M${n1(x)} ${n1(top)}L${n1(x + ww / 2)} ${n1(bot)}L${n1(x - ww / 2)} ${n1(bot)}Z`;
  }
  return `<path d="${d}" fill="${color}"/><rect x="${n1(x - 1)}" y="${n1(base - h * 0.25)}" width="2" height="${n1(h * 0.25)}" fill="${color}"/>`;
}

// ---------------------------------------------------------------- scenes

function beach(r, seed) {
  const tod = timeOfDay(r, false);
  const hz = 112 + r() * 22;
  const sk = sky(r, tod, seed, hz);
  const shoreY = 172 + r() * 22;
  const deep = tod === 'dusk' ? hsl(250, 25, 32) : tod === 'golden' ? hsl(200, 38, 36) : hsl(206, 58, 32);
  const near = tod === 'dusk' ? hsl(300, 22, 48) : hsl(182, 52, 46);
  const defs = sk.defs + `
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${deep}"/><stop offset="1" stop-color="${near}"/></linearGradient>
    <linearGradient id="sand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(40, 52, 74)}"/><stop offset="1" stop-color="${hsl(34, 42, 58)}"/></linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="1.2"/></filter>`;
  let body = sk.body + `<rect y="${n1(hz)}" width="${V}" height="${n1(V - hz)}" fill="url(#sea)"/>`;
  if (tod !== 'day') {
    body += `<ellipse cx="${n1(sk.sunX)}" cy="${n1(hz + 28)}" rx="9" ry="30" fill="${sk.sunColor}" opacity="0.4" filter="url(#soft)"/>`;
  }
  for (let i = 0; i < 9; i++) {
    const y = hz + 8 + r() * (shoreY - hz - 10);
    const x = r() * V;
    const w = 20 + r() * 40;
    body += `<path d="M${n1(x)} ${n1(y)}q${n1(w / 2)} -2 ${n1(w)} 0" stroke="#fff" stroke-width="${n1(0.6 + r())}" fill="none" opacity="${n1(0.18 + r() * 0.25)}"/>`;
  }
  const shore = `M-5 ${n1(shoreY)}C70 ${n1(shoreY - 8 - r() * 6)} 160 ${n1(shoreY + 4 + r() * 6)} 245 ${n1(shoreY - 4)}`;
  body += `<path d="${shore}V${V}H-5Z" fill="url(#sand)"/>`
    + `<path d="${shore}" stroke="rgba(110,80,50,0.25)" stroke-width="7" fill="none" transform="translate(0 4)"/>`
    + `<path d="${shore}" stroke="#fff" stroke-width="3" fill="none" opacity="0.75" filter="url(#soft)"/>`;
  if (r() < 0.6) { // umbrellas
    const count = 2 + Math.floor(r() * 3);
    for (let i = 0; i < count; i++) {
      const x = 20 + r() * 200;
      const y = shoreY + 18 + r() * 26;
      const c = pick(r, ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#457b9d', '#ffffff']);
      const s = 0.8 + r() * 0.6;
      body += `<line x1="${n1(x)}" y1="${n1(y)}" x2="${n1(x)}" y2="${n1(y - 16 * s)}" stroke="#4a3a2a" stroke-width="1.2"/>`
        + `<path d="M${n1(x - 12 * s)} ${n1(y - 14 * s)}Q${n1(x)} ${n1(y - 26 * s)} ${n1(x + 12 * s)} ${n1(y - 14 * s)}Z" fill="${c}"/>`
        + `<ellipse cx="${n1(x + 4)}" cy="${n1(y + 1)}" rx="${n1(11 * s)}" ry="2" fill="rgba(60,40,20,0.25)"/>`;
    }
  }
  if (r() < 0.4) { // palm silhouette
    const left = r() < 0.5;
    const bx = left ? 18 + r() * 20 : 200 + r() * 20;
    const tx = bx + (left ? 14 : -14);
    const ty = 40 + r() * 30;
    let palm = `<path d="M${n1(bx)} ${V}Q${n1(bx + (tx - bx) * 0.2)} ${n1((ty + V) / 2)} ${n1(tx)} ${n1(ty)}" stroke="#2a2117" stroke-width="5" fill="none"/>`;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + r() * 0.4;
      const len = 26 + r() * 14;
      const ex = tx + Math.cos(a) * len;
      const ey = ty + Math.sin(a) * len * 0.55 + 10;
      palm += `<path d="M${n1(tx)} ${n1(ty)}Q${n1((tx + ex) / 2)} ${n1(Math.min(ty, ey) - 10)} ${n1(ex)} ${n1(ey)}" stroke="#23301c" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
    }
    body += palm;
  }
  return { defs, body };
}

function island(r, seed) {
  const tod = r() < 0.7 ? 'day' : 'golden';
  const hz = 104 + r() * 14;
  const sk = sky(r, tod, seed, hz);
  const defs = sk.defs + `
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(212, 62, 30)}"/><stop offset="1" stop-color="${hsl(200, 60, 42)}"/></linearGradient>
    <linearGradient id="cliff" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hsl(18, 32, 38)}"/><stop offset="1" stop-color="${hsl(12, 30, 22)}"/></linearGradient>`;
  let body = sk.body + `<rect y="${n1(hz)}" width="${V}" height="${n1(V - hz)}" fill="url(#sea)"/>`;
  const edge = 120 + r() * 50; // where the cliff drops into the sea
  const cliffTop = (x) => 118 + (x / edge) * 30 + Math.sin(x / 9) * 3;
  const outline = Array.from({ length: 12 }, (_, i) => {
    const x = (i + 1) * edge / 12;
    return `L${n1(x)} ${n1(cliffTop(x))}`;
  }).join('');
  body += `<path d="M-5 ${n1(cliffTop(0))}${outline}L${n1(edge + 30)} ${V}L-5 ${V}Z" fill="url(#cliff)"/>`;
  for (let row = 0; row < 4; row++) {
    for (let x = -4; x < edge - 6; x += 9 + r() * 10) {
      const w = 10 + r() * 12;
      const h = 8 + r() * 9;
      const y = cliffTop(x) - h + 4 + row * 15 + r() * 4;
      if (y > V - 10) continue;
      body += `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" fill="#f8f6f1"/>`
        + `<rect x="${n1(x + w * 0.7)}" y="${n1(y)}" width="${n1(w * 0.3)}" height="${n1(h)}" fill="#dedad1"/>`
        + `<rect x="${n1(x + w * 0.3)}" y="${n1(y + h * 0.45)}" width="2.2" height="3" fill="${hsl(208, 60, 42)}"/>`;
      if (r() < 0.22) {
        const cx = x + w / 2;
        const rd = Math.min(w, 14) / 2;
        body += `<path d="M${n1(cx - rd)} ${n1(y)}A${n1(rd)} ${n1(rd)} 0 0 1 ${n1(cx + rd)} ${n1(y)}Z" fill="${hsl(214, 72, 38)}"/>`;
      }
    }
  }
  return { defs, body };
}

function city(r, seed, style) {
  const tod = timeOfDay(r, true);
  const ground = 176 + r() * 18;
  const sk = sky(r, tod, seed, ground);
  const dark = tod === 'night' ? 0.35 : tod === 'dusk' ? 0.7 : 1;
  const lit = tod === 'night' || tod === 'dusk';
  const river = r() < 0.4;
  let defs = sk.defs + (river ? waterDefs(seed, ground) : '');
  let body = sk.body;

  // distant hazy layer
  let far = '';
  for (let x = -6; x < V;) {
    const w = 10 + r() * 22;
    const h = 30 + r() * 45;
    far += `<rect x="${n1(x)}" y="${n1(ground - h - 6)}" width="${n1(w + 1)}" height="${n1(h + 6)}"/>`;
    x += w;
  }
  body += `<g fill="${hsl(...sk.haze)}" opacity="0.6">${far}</g>`;

  // near buildings
  let near = '';
  for (let x = -6; x < V;) {
    const w = 16 + r() * 24;
    const h = 40 + r() * 70;
    const top = ground - h;
    let wall;
    let roof;
    if (style.roof === 'terracotta') {
      wall = hsl(28 + r() * 18, 35 + r() * 25, (60 + r() * 18) * dark);
      roof = hsl(10 + r() * 8, 55, 42 * dark);
    } else if (style.roof === 'slate') {
      wall = hsl(38, 18 + r() * 10, (76 + r() * 10) * dark);
      roof = hsl(215, 9, 44 * dark);
    } else {
      wall = hsl(r() * 360, 12 + r() * 22, (48 + r() * 28) * dark);
      roof = hsl(20, 15, 28 * dark);
    }
    near += `<rect x="${n1(x)}" y="${n1(top)}" width="${n1(w + 0.6)}" height="${n1(h + 2)}" fill="${wall}"/>`;
    if (style.roof === 'slate') {
      near += `<path d="M${n1(x)} ${n1(top)}L${n1(x + 3)} ${n1(top - 9)}H${n1(x + w - 3)}L${n1(x + w)} ${n1(top)}Z" fill="${roof}"/>`;
    } else if (style.roof === 'terracotta' || r() < 0.5) {
      near += `<path d="M${n1(x - 1)} ${n1(top)}L${n1(x + w / 2)} ${n1(top - 6 - r() * 6)}L${n1(x + w + 1)} ${n1(top)}Z" fill="${roof}"/>`;
    }
    for (let wy = top + 6; wy < ground - 8; wy += 10) {
      for (let wx = x + 3; wx < x + w - 4; wx += 6.5) {
        const on = lit && r() < 0.55;
        const fill = on ? (r() < 0.7 ? '#ffd27a' : '#ffe9b8') : hsl(212, 20, 26 * dark + 6);
        near += `<rect x="${n1(wx)}" y="${n1(wy)}" width="3.2" height="4.6" fill="${fill}" opacity="${on ? 0.95 : 0.65}"/>`;
      }
    }
    x += w;
  }
  if (style.dome) {
    const cx = 80 + r() * 80;
    const base = ground - 70 - r() * 15;
    const rw = 26 + r() * 8;
    const domeColor = style.roof === 'terracotta' ? hsl(14, 58, 44 * dark) : hsl(160, 12, 52 * dark);
    near += `<rect x="${n1(cx - rw)}" y="${n1(base)}" width="${n1(rw * 2)}" height="${n1(ground - base)}" fill="${hsl(36, 30, 72 * dark)}"/>`
      + `<path d="M${n1(cx - rw)} ${n1(base)}Q${n1(cx - rw)} ${n1(base - rw * 1.2)} ${n1(cx)} ${n1(base - rw * 1.25)}Q${n1(cx + rw)} ${n1(base - rw * 1.2)} ${n1(cx + rw)} ${n1(base)}Z" fill="${domeColor}"/>`
      + `<rect x="${n1(cx - 3)}" y="${n1(base - rw * 1.25 - 9)}" width="6" height="9" fill="${hsl(36, 25, 80 * dark)}"/>`
      + `<path d="M${n1(cx - 4)} ${n1(base - rw * 1.25 - 9)}L${n1(cx)} ${n1(base - rw * 1.25 - 15)}L${n1(cx + 4)} ${n1(base - rw * 1.25 - 9)}Z" fill="${domeColor}"/>`;
  }
  defs += `<g id="near">${near}</g>`;
  body += `<use href="#near"/>`;

  if (river) {
    body += `<rect y="${n1(ground)}" width="${V}" height="${n1(V - ground)}" fill="${hsl(200, 28, 24 * dark + 6)}"/>`
      + reflection('near', ground, 0.55);
  } else {
    body += `<rect y="${n1(ground)}" width="${V}" height="${n1(V - ground)}" fill="${hsl(30, 6, 30 * dark)}"/>`
      + `<rect y="${n1(ground + 6)}" width="${V}" height="1.5" fill="#fff" opacity="0.25"/>`;
    for (let i = 0; i < 4; i++) { // street lights / cars
      const x = r() * V;
      body += lit
        ? `<circle cx="${n1(x)}" cy="${n1(ground + 14 + r() * 20)}" r="1.6" fill="#ffd27a"/>`
        : `<rect x="${n1(x)}" y="${n1(ground + 12 + r() * 20)}" width="12" height="5" rx="2" fill="${pick(r, ['#c0392b', '#2c3e50', '#ecf0f1', '#2980b9', '#7f8c8d'])}"/>`;
    }
  }
  return { defs, body };
}

function canal(r, seed, style) {
  const tod = timeOfDay(r, true);
  const waterY = 158 + r() * 14;
  const sk = sky(r, tod, seed, waterY);
  const dark = tod === 'night' ? 0.4 : tod === 'dusk' ? 0.75 : 1;
  const lit = tod === 'night' || tod === 'dusk';
  let defs = sk.defs + waterDefs(seed, waterY);
  let houses = '';
  for (let x = -4; x < V;) {
    const w = 20 + r() * 12;
    const h = 62 + r() * 48;
    const top = waterY - 4 - h;
    const color = style.brick
      ? hsl(8 + r() * 12, 45 + r() * 15, (30 + r() * 14) * dark)
      : hsl(pick(r, [4, 18, 32, 45, 200, 145, 345, 25]), 32 + r() * 28, (40 + r() * 28) * dark);
    const gable = pick(r, ['step', 'bell', 'point', 'flat']);
    let g = `<rect x="${n1(x)}" y="${n1(top)}" width="${n1(w + 0.5)}" height="${n1(h + 4)}" fill="${color}"/>`;
    if (gable === 'step') {
      const s = w / 6;
      g += `<path d="M${n1(x)} ${n1(top)}v-6h${n1(s)}v-6h${n1(s)}v-6h${n1(2 * s)}v6h${n1(s)}v6h${n1(s)}v6Z" fill="${color}"/>`;
    } else if (gable === 'bell') {
      g += `<path d="M${n1(x + 2)} ${n1(top)}C${n1(x + 2)} ${n1(top - 10)} ${n1(x + w / 2 - 4)} ${n1(top - 8)} ${n1(x + w / 2)} ${n1(top - 18)}C${n1(x + w / 2 + 4)} ${n1(top - 8)} ${n1(x + w - 2)} ${n1(top - 10)} ${n1(x + w - 2)} ${n1(top)}Z" fill="${color}"/>`;
    } else if (gable === 'point') {
      g += `<path d="M${n1(x)} ${n1(top)}L${n1(x + w / 2)} ${n1(top - 16)}L${n1(x + w)} ${n1(top)}Z" fill="${color}"/>`;
    } else {
      g += `<rect x="${n1(x)}" y="${n1(top - 3)}" width="${n1(w)}" height="3" fill="#f2efe6" opacity="0.85"/>`;
    }
    const cols = w > 26 ? 3 : 2;
    const cw = (w - 6) / cols;
    for (let wy = top + 7; wy < waterY - 16; wy += 15) {
      for (let c = 0; c < cols; c++) {
        const wx = x + 3 + c * cw + cw * 0.2;
        const on = lit && r() < 0.55;
        g += `<rect x="${n1(wx)}" y="${n1(wy)}" width="${n1(cw * 0.6)}" height="8" fill="${on ? '#ffd88a' : hsl(210, 25, 22 * dark + 4)}" stroke="#f4f1ea" stroke-width="1" stroke-opacity="${n1(0.85 * dark)}"/>`;
      }
    }
    houses += g;
    x += w;
  }
  houses += `<rect y="${n1(waterY - 5)}" width="${V}" height="6" fill="${hsl(30, 8, 30 * dark)}"/>`;
  if (r() < 0.45) { // boat
    const bx = 30 + r() * 150;
    const by = waterY + 14 + r() * 20;
    const hull = pick(r, ['#2c3e50', '#7b2d26', '#1f4e5f', '#e8e2d0']);
    houses += `<path d="M${n1(bx)} ${n1(by)}h46l-6 8h-36Z" fill="${hull}"/>`
      + `<rect x="${n1(bx + 12)}" y="${n1(by - 8)}" width="20" height="8" rx="1.5" fill="#efe9dc"/>`;
  }
  defs += `<g id="houses">${houses}</g>`;
  const body = sk.body
    + `<rect y="${n1(waterY)}" width="${V}" height="${n1(V - waterY)}" fill="${hsl(188, 30, 22 * dark + 4)}"/>`
    + reflection('houses', waterY + 1, 0.55)
    + `<use href="#houses"/>`;
  return { defs, body };
}

function mountains(r, tod, golden, layers, snowline) {
  let g = '';
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    const t = i / (layers.length - 1); // 0 = far, 1 = near
    // golden hour: warm far layers, cool near layers – no hue sweep through green
    const hue = golden ? (i < 2 ? 25 + i * 8 : 222) : 212 + t * 10;
    const sat = golden ? 22 + t * 6 : 18 + t * 10;
    const light = (tod === 'dusk' ? 0.75 : 1) * (78 - t * 52);
    const d = ridge(r, L.yL, L.yR, L.disp, 7);
    g += `<path d="${d}" fill="${hsl(hue, sat, light)}"/>`;
    if (i < 2 && snowline) {
      g += `<g clip-path="url(#snow${i})"><path d="${d}" fill="#f4f7fb" opacity="${n1(0.95 - i * 0.15)}"/></g>`;
    }
  }
  return g;
}

function alpine(r, seed, style) {
  const tod = timeOfDay(r, false);
  const lake = r() < 0.5;
  const waterY = 168 + r() * 16;
  const sk = sky(r, tod, seed, 140);
  const peak = style.peaky ? 120 : 70;
  const snowline = 92 + r() * 12;
  let defs = sk.defs + (lake ? waterDefs(seed, waterY) : '')
    + snowClip(r, 'snow0', snowline)
    + snowClip(r, 'snow1', snowline + 8);
  const layers = [
    { yL: 70 + r() * 30, yR: 70 + r() * 30, disp: peak },
    { yL: 105 + r() * 20, yR: 100 + r() * 20, disp: 60 },
    { yL: 135 + r() * 15, yR: 130 + r() * 15, disp: 40 },
    { yL: 158 + r() * 10, yR: 155 + r() * 12, disp: 26 },
  ];
  defs += `<g id="mtn">${mountains(r, tod, tod === 'golden', layers, snowline)}</g>`;
  let body = sk.body + `<use href="#mtn"/>`;
  const pineColor = hsl(150, 28, tod === 'dusk' ? 12 : 17);
  if (lake) {
    body += `<rect y="${n1(waterY)}" width="${V}" height="${n1(V - waterY)}" fill="${hsl(205, 35, 32)}"/>` + reflection('mtn', waterY, 0.55);
    for (let i = 0; i < 6; i++) body += pine(r() < 0.5 ? r() * 40 : 200 + r() * 40, waterY + 2, 30 + r() * 30, pineColor);
  } else {
    body += `<path d="M-5 ${n1(waterY)}Q120 ${n1(waterY - 14)} 245 ${n1(waterY + 4)}V${V}H-5Z" fill="${hsl(95 + r() * 15, 38, tod === 'dusk' ? 26 : 38)}"/>`;
    for (let i = 0; i < 10; i++) body += pine(r() * V, waterY + 10 + r() * 50, 28 + r() * 34, pineColor);
  }
  return { defs, body };
}

function fjord(r, seed) {
  const tod = pick(r, ['golden', 'dusk', 'day', 'golden']);
  const waterY = 150 + r() * 14;
  const sk = sky(r, tod, seed, waterY);
  let defs = sk.defs + waterDefs(seed, waterY)
    + snowClip(r, 'snow0', 85 + r() * 15);
  const rockDark = hsl(222, 14, tod === 'dusk' ? 16 : 22);
  const far = ridge(r, waterY - 40, waterY - 45, 30, 6);
  const leftEnd = 90 + r() * 30;
  const left = `M-6 ${n1(40 + r() * 25)}L${n1(leftEnd * 0.3)} ${n1(55 + r() * 20)}L${n1(leftEnd * 0.6)} ${n1(90 + r() * 20)}L${n1(leftEnd)} ${n1(waterY)}L-6 ${n1(waterY)}Z`;
  const rightStart = 150 + r() * 30;
  const right = `M246 ${n1(50 + r() * 25)}L${n1(rightStart + 50)} ${n1(70 + r() * 20)}L${n1(rightStart + 20)} ${n1(110 + r() * 15)}L${n1(rightStart)} ${n1(waterY)}L246 ${n1(waterY)}Z`;
  let scene = `<path d="${far}" fill="${hsl(...sk.haze)}" opacity="0.8"/>`
    + `<path d="${left}" fill="${rockDark}"/><g clip-path="url(#snow0)"><path d="${left}" fill="#eef2f7" opacity="0.85"/></g>`
    + `<path d="${right}" fill="${rockDark}"/>`;
  for (let i = 0; i < 4; i++) { // red cabins on stilts
    const x = rightStart + 6 + i * 20 + r() * 6;
    const w = 14 + r() * 5;
    const h = 10 + r() * 4;
    const y = waterY - h - 4;
    scene += `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" fill="${hsl(356, 62, 38)}"/>`
      + `<path d="M${n1(x - 1)} ${n1(y)}L${n1(x + w / 2)} ${n1(y - 7)}L${n1(x + w + 1)} ${n1(y)}Z" fill="${hsl(20, 10, 18)}"/>`
      + `<rect x="${n1(x + w * 0.35)}" y="${n1(y + h * 0.35)}" width="3" height="4" fill="#f2efe6"/>`
      + `<path d="M${n1(x + 2)} ${n1(y + h)}v5M${n1(x + w - 2)} ${n1(y + h)}v5" stroke="${hsl(20, 10, 18)}" stroke-width="1.2"/>`;
  }
  defs += `<g id="fjord">${scene}</g>`;
  const body = sk.body + `<use href="#fjord"/>`
    + `<rect y="${n1(waterY)}" width="${V}" height="${n1(V - waterY)}" fill="${hsl(208, 32, tod === 'dusk' ? 20 : 28)}"/>`
    + reflection('fjord', waterY, 0.6);
  return { defs, body };
}

const SCENES = { beach, island, city, canal, alpine, fjord };

export function renderScene(style, id, px) {
  const seed = id * 7919 + 17;
  const r = rng(seed);
  const scene = (SCENES[style.theme] || city)(r, seed, style);
  const fin = finish(seed);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${V} ${V}">`
    + `<defs>${scene.defs}${fin.defs}</defs>${scene.body}${fin.body}</svg>`;
}
