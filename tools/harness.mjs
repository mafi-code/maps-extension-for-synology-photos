// Shared test harness: test copy of the extension, a fake Synology Photos
// server and a headless Edge driven over the Chrome DevTools Protocol.
// No npm dependencies – needs Node 22+ (global fetch/WebSocket) and Microsoft Edge.
// (Google Chrome ignores --load-extension since version 137, Edge still honours it.)
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXT_FILES = ['manifest.json', 'content.js', 'content.css', 'map.html', 'map.js', 'map.css',
  'page-hook.js', 'popup.html', 'popup.js', 'vendor', 'icons', '_locales'];

// ---------- test copy of the extension ----------

// The real extension is enabled per NAS via the popup (a click the test can't
// make), so the test copy declares static content scripts for 127.0.0.1.
export function makeTestExtension({ demoHook = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-ext-'));
  for (const f of EXT_FILES) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });

  const manifestPath = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  m.host_permissions = ['http://127.0.0.1/*'];
  m.content_scripts = [
    { matches: ['http://127.0.0.1/*'], js: ['page-hook.js'], world: 'MAIN', run_at: 'document_start' },
    { matches: ['http://127.0.0.1/*'], js: ['content.js'], css: ['content.css'], run_at: 'document_idle' },
  ];
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

  if (demoHook) {
    // Lets the screenshot script move the map. Only in the temporary copy.
    const mapJs = path.join(dir, 'map.js');
    const src = fs.readFileSync(mapJs, 'utf8');
    const out = src.replace(/^(\s*map\.addLayer\(cluster\);)\r?$/m, '$1\n  window.__spmDemo = { map, cluster };');
    if (out === src) throw new Error('demo hook: anchor "map.addLayer(cluster);" not found in map.js');
    fs.writeFileSync(mapJs, out);
  }
  return dir;
}

// ---------- fake Synology Photos ----------

/**
 * @param {object} opts
 * @param {object[]} opts.items      Synology-style items ({ id, filename, time, additional })
 * @param {(id:number, size:string) => string} opts.thumb  returns an SVG thumbnail
 * @param {() => string} [opts.page] HTML of the photo page (served at / and /photo/)
 * @param {boolean} [opts.flaky]     one garbage response at offset 13000, short page at 20000
 */
export function createMockSynology({ items, thumb, page, flaky = false }) {
  const calls = [];
  let failedOnce = false;
  const defaultPage = () => '<!doctype html><title>Synology Photos</title><body><h1>Mock Synology Photos</h1></body>';
  // Every page makes one API call with a token, like the real app does.
  const tokenProbe = `<script>fetch('/webapi/entry.cgi/SYNO.Foto.Browse.Timeline',{method:'POST',headers:{'X-SYNO-TOKEN':'tok123','Content-Type':'application/x-www-form-urlencoded'},body:'api=SYNO.Foto.Browse.Timeline&method=get&version=1'});</script>`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/photo/' || url.pathname === '/photo') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end((page || defaultPage)().replace('</body>', `${tokenProbe}</body>`));
      return;
    }
    if (url.pathname.startsWith('/thumb/')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(thumb(Number(url.pathname.split('/')[2]), 'sm'));
      return;
    }
    if (!url.pathname.startsWith('/webapi/entry.cgi')) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.searchParams.get('api') === 'SYNO.Foto.Thumbnail') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(thumb(Number(url.searchParams.get('id')), url.searchParams.get('size') || 'sm'));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const api = p.get('api');
      const method = p.get('method');
      calls.push({ api, method, offset: p.get('offset'), token: req.headers['x-syno-token'] || null });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (api === 'SYNO.Foto.Browse.Item' && method === 'list') {
        const offset = Number(p.get('offset'));
        let limit = Number(p.get('limit'));
        if (flaky && offset === 13000 && !failedOnce) {
          failedOnce = true;
          res.end('<html>502 Bad Gateway</html>'); // not JSON → must be retried
          return;
        }
        if (flaky && offset === 20000) limit = 300; // short page in the middle
        res.end(JSON.stringify({ success: true, data: { list: items.slice(offset, offset + limit) } }));
      } else if (api === 'SYNO.Foto.UserInfo' && method === 'me') {
        res.end(JSON.stringify({ success: true, data: { id: 7, name: 'tester' } }));
      } else if (api === 'SYNO.FotoTeam.Browse.Item') {
        res.end(JSON.stringify({ success: false, error: { code: 105 } })); // no shared space
      } else {
        res.end(JSON.stringify({ success: true, data: {} }));
      }
    });
  });

  return {
    calls,
    listen: (port) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------- browser + CDP ----------

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Microsoft Edge nicht gefunden – Pfad per BROWSER_PATH angeben.');
  return found;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    this.frames = [];       // auto-attached child targets: { sessionId, type }
    this.exceptions = [];   // uncaught exceptions in any target
    this.console = [];      // console messages from any target
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  onMessage(msg) {
    if (msg.id && this.waiting.has(msg.id)) {
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(`${JSON.stringify(msg.error)}`));
      else w.resolve(msg.result);
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      this.frames.push({ sessionId, type: targetInfo.type });
      this.send('Runtime.enable', {}, sessionId).catch(() => {});
      this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
      this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      this.console.push({ type: msg.params.type, text });
      if (process.env.VERBOSE) console.log(`    [console.${msg.params.type}] ${text.slice(0, 200)}`);
    }
  }

  async evaluate(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }

  /** Opens a tab, auto-attaches its frames and returns the page session id. */
  async openPage(url, { width = 1280, height = 800, scale = 1 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    return sessionId;
  }

  /** Finds the session of the extension's map iframe. */
  async findMapFrame(timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      for (const f of this.frames.filter((x) => x.type === 'iframe')) {
        try {
          const href = await this.evaluate(f.sessionId, 'location.href');
          const m = /^(chrome-extension:\/\/[^/]+)\/map\.html/.exec(href);
          if (m) return { sessionId: f.sessionId, extOrigin: m[1] };
        } catch (_) { /* frame not ready yet */ }
      }
      await sleep(250);
    }
    throw new Error('Karten-iframe nicht gefunden');
  }
}

/** lang: browser UI language, decides which _locales/<lang> the extension uses. */
export async function launchBrowser({ extDir, port, lang = 'de-DE' }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-profile-'));
  const extArgs = extDir ? [`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`] : [];
  const proc = spawn(findBrowser(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    ...extArgs, '--no-first-run', '--hide-scrollbars', `--lang=${lang}`, 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 75 && !ws; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const sock = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { sock.onopen = resolve; sock.onerror = reject; });
      ws = sock;
    } catch (_) {
      await sleep(200);
    }
  }
  if (!ws) {
    proc.kill();
    throw new Error('Browser über CDP nicht erreichbar');
  }

  const cdp = new Cdp(ws);
  cdp.close = async () => {
    try { ws.close(); } catch (_) { /* ignore */ }
    proc.kill();
    await sleep(800);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* locked – OS cleans temp */ }
  };
  return cdp;
}

/** Polls fn() until it returns a truthy value or the timeout elapses. */
export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}
