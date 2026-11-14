/*! Tessera crash capture SDK 1.0 (E6A). No dependencies, nothing to build.
 *
 * In a web page:
 *   <script src="https://YOUR-TESSERA-API/sdk/tessera.js" data-key="tsk_..." data-release="1.4.2" defer></script>
 * Uncaught errors and unhandled promise rejections are sent automatically. Send your own with
 *   Tessera.capture(error)
 *
 * Anywhere with fetch (Node 18+, workers):
 *   Tessera.init({ key: 'tsk_...', endpoint: 'https://YOUR-TESSERA-API/api/ingest', release: '1.4.2' });
 *   await Tessera.capture(error);
 * On a server nothing is captured automatically: call capture() where you handle errors.
 *
 * What is sent: the error type, message and stack, the page address without its query string,
 * the release and environment you set, and an id for the person only if you call setUser().
 * The browser sends its user agent. Nothing else (no cookies, no page content, no console).
 */
(function (root) {
  'use strict';
  var MAX_PER_PAGE = 25; // never more than this many reports from one page load
  var REPEAT_MS = 10000; // the same error again within 10 seconds is not resent
  var cfg = null;
  var sent = 0;
  var lastSeen = {};

  function warn(msg) { if (root.console && root.console.warn) root.console.warn('[tessera] ' + msg); }

  function normalize(err) {
    if (err instanceof Error || (err && typeof err === 'object' && 'message' in err)) {
      return { type: err.name || 'Error', message: String(err.message || ''), stack: typeof err.stack === 'string' ? err.stack : undefined };
    }
    // Something that isn't an Error was thrown or rejected.
    var text;
    try { text = typeof err === 'string' ? err : JSON.stringify(err); } catch (e) { text = String(err); }
    return { type: 'Error', message: 'Non-error value: ' + String(text).slice(0, 500) };
  }

  function init(options) {
    options = options || {};
    if (!options.key || String(options.key).indexOf('tsk_') !== 0) { warn('init needs your ingest key (it starts with tsk_)'); return; }
    cfg = {
      key: String(options.key),
      endpoint: options.endpoint,
      release: options.release ? String(options.release) : undefined,
      environment: options.environment ? String(options.environment) : undefined,
      user: options.user ? String(options.user) : undefined,
      beforeSend: typeof options.beforeSend === 'function' ? options.beforeSend : null,
    };
    if (!cfg.endpoint) warn('init needs the endpoint, e.g. https://YOUR-TESSERA-API/api/ingest');
    if (options.captureUnhandled !== false && typeof root.addEventListener === 'function' && root.document) {
      root.addEventListener('error', function (event) {
        if (!event) return;
        if (event.error) capture(event.error);
        // Cross-origin scripts only give "Script error." with no details: nothing useful to send.
        else if (event.message && event.message !== 'Script error.') {
          capture({ name: 'Error', message: event.message, stack: event.filename ? '    at ' + event.filename + ':' + event.lineno + ':' + event.colno : undefined });
        }
      });
      root.addEventListener('unhandledrejection', function (event) { capture(event && 'reason' in event ? event.reason : 'Unhandled rejection'); });
    }
  }

  function capture(err) {
    if (!cfg || !cfg.endpoint) { warn('call Tessera.init first'); return Promise.resolve(false); }
    var e = normalize(err);
    var fingerprint = e.type + '|' + e.message + '|' + String(e.stack || '').split('\n')[1];
    var now = Date.now();
    if (lastSeen[fingerprint] && now - lastSeen[fingerprint] < REPEAT_MS) return Promise.resolve(false);
    if (sent >= MAX_PER_PAGE) return Promise.resolve(false);
    lastSeen[fingerprint] = now;
    var payload = {
      key: cfg.key,
      type: e.type,
      message: e.message.slice(0, 2000),
      stack: e.stack ? e.stack.slice(0, 20000) : undefined,
      url: root.location ? String(root.location.href) : undefined,
      release: cfg.release,
      environment: cfg.environment,
      user: cfg.user,
    };
    if (cfg.beforeSend) {
      try { payload = cfg.beforeSend(payload); } catch (x) { warn('beforeSend threw; report not sent'); return Promise.resolve(false); }
      if (!payload) return Promise.resolve(false);
    }
    if (typeof root.fetch !== 'function') { warn('this environment has no fetch'); return Promise.resolve(false); }
    sent += 1;
    // text/plain keeps it a "simple" request, so browsers send it without a preflight;
    // keepalive lets it finish while the page is closing.
    return root.fetch(cfg.endpoint, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain' }, keepalive: true, credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) warn('report refused (' + res.status + ')');
        return res.ok;
      }, function () { return false; });
  }

  function setUser(id) { if (cfg) cfg.user = id ? String(id) : undefined; }

  var api = { init: init, capture: capture, setUser: setUser, version: '1.0.0' };
  root.Tessera = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;

  // <script data-key="tsk_..."> starts it straight away; the endpoint is the same server the script came from.
  var script = root.document && root.document.currentScript;
  if (script && script.getAttribute('data-key')) {
    init({
      key: script.getAttribute('data-key'),
      endpoint: script.getAttribute('data-endpoint') || new URL('/api/ingest', script.src).href,
      release: script.getAttribute('data-release') || undefined,
      environment: script.getAttribute('data-environment') || undefined,
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
