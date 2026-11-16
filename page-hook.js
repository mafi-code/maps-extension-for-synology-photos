// Runs in the page's MAIN world at document_start.
// Watches the requests Synology Photos makes itself, so the extension can reuse
// the same CSRF token (SynoToken) and the same API endpoint path.
// Findings are written as data attributes on <html>, which the isolated
// content script can read (the DOM is shared between both worlds).
(() => {
  if (window.__spmHookInstalled) return;
  window.__spmHookInstalled = true;

  const root = document.documentElement;
  const set = (key, value) => {
    if (value && root.dataset[key] !== value) root.dataset[key] = value;
  };

  const inspectUrl = (url) => {
    try {
      const u = new URL(String(url), location.href);
      if (u.origin !== location.origin) return;
      const m = u.pathname.match(/^(.*\/webapi\/entry\.cgi)/);
      if (m) set('spmApiPath', m[1]);
      const t = u.searchParams.get('SynoToken');
      if (t) set('spmToken', t);
    } catch (_) { /* ignore unparsable URLs */ }
  };

  const inspectBody = (body) => {
    if (typeof body !== 'string' || !body.includes('SynoToken=')) return;
    try {
      const t = new URLSearchParams(body).get('SynoToken');
      if (t) set('spmToken', t);
    } catch (_) { /* ignore */ }
  };

  const inspectHeaders = (headers) => {
    if (!headers) return;
    try {
      const h = new Headers(headers);
      const t = h.get('X-SYNO-TOKEN');
      if (t) set('spmToken', t);
    } catch (_) { /* ignore */ }
  };

  // XMLHttpRequest
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    inspectUrl(url);
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === 'x-syno-token') set('spmToken', value);
    return xhrSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (body) {
    inspectBody(body);
    return xhrSend.call(this, body);
  };

  // fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (input instanceof Request) {
        inspectUrl(input.url);
        inspectHeaders(input.headers);
      } else {
        inspectUrl(input);
      }
      if (init) {
        inspectHeaders(init.headers);
        inspectBody(init.body);
      }
    } catch (_) { /* never break the app */ }
    return origFetch.apply(this, arguments);
  };

  // Known DSM global, if present.
  let tries = 0;
  const poll = setInterval(() => {
    try {
      const t = window.SYNO && window.SYNO.SDS && window.SYNO.SDS.Session && window.SYNO.SDS.Session.SynoToken;
      if (t) set('spmToken', t);
    } catch (_) { /* ignore */ }
    if (++tries > 30) clearInterval(poll);
  }, 1000);
})();
