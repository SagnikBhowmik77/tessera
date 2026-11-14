/*! Tessera report button 1.0 (E6C). No dependencies, nothing to build.
 *
 *   <script src="https://YOUR-TESSERA-API/sdk/widget.js" data-portal="PORTAL-TOKEN" defer></script>
 *
 * Optional: data-label="Report a problem", data-position="left", data-color="#7c6cf0".
 * It adds a small button to the page. People who use it write what went wrong and can add:
 *  - a screenshot of this page (the browser asks them to share the tab first) or an image file,
 *    marked up with boxes before sending;
 *  - the page's recent console errors, only if they tick the box, after seeing exactly which.
 * Always sent with a report: this page's address without its query string, the browser, the
 * window size. Nothing else is read from the page. Console errors are kept in memory only,
 * on this page, and never sent unless the box is ticked.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || !script.getAttribute('data-portal')) return;
  if (window.__tesseraWidget) return;
  window.__tesseraWidget = true;

  var token = script.getAttribute('data-portal');
  var endpoint = new URL('/api/widget/' + encodeURIComponent(token), script.src).href;
  var label = script.getAttribute('data-label') || 'Report a problem';
  var color = /^#[0-9a-f]{3,8}$/i.test(script.getAttribute('data-color') || '') ? script.getAttribute('data-color') : '#7c6cf0';
  var left = script.getAttribute('data-position') === 'left';

  // ---- Recent console errors, kept here only (last 10).
  var errors = [];
  function remember(message, stack) {
    if (!message) return;
    errors.push({ message: String(message).slice(0, 2000), stack: stack ? String(stack).slice(0, 10000) : undefined });
    if (errors.length > 10) errors.shift();
  }
  var origError = console.error;
  console.error = function () {
    try {
      var first = arguments[0];
      if (first instanceof Error) remember(first.name + ': ' + first.message, first.stack);
      else remember(Array.prototype.map.call(arguments, function (a) { return typeof a === 'string' ? a : (function () { try { return JSON.stringify(a); } catch (e) { return String(a); } })(); }).join(' '));
    } catch (e) { /* never break the page's own logging */ }
    return origError.apply(console, arguments);
  };
  window.addEventListener('error', function (e) { if (e && e.error) remember(e.error.name + ': ' + e.error.message, e.error.stack); else if (e && e.message) remember(e.message); });
  window.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; remember(r && r.message ? (r.name || 'Error') + ': ' + r.message : 'Unhandled rejection: ' + String(r), r && r.stack); });

  // ---- UI in a shadow root, so the page's styles and ours never mix.
  var host = document.createElement('div');
  host.setAttribute('data-tessera-widget', '');
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.btn{position:fixed;bottom:20px;' + (left ? 'left' : 'right') + ':20px;z-index:2147483646;background:' + color + ';color:#fff;border:0;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
    '.panel{position:fixed;bottom:72px;' + (left ? 'left' : 'right') + ':20px;z-index:2147483647;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 100px);overflow:auto;background:#fff;color:#18181b;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.3);padding:16px;font-size:13px}' +
    'h2{margin:0 0 8px;font-size:15px}label{display:block;margin:8px 0 3px;font-weight:600;font-size:12px}' +
    'input,textarea{width:100%;border:1px solid #d4d4d8;border-radius:8px;padding:7px 9px;font-size:13px;color:#18181b;background:#fff}textarea{min-height:70px;resize:vertical}' +
    '.row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.small{font-size:11px;color:#71717a;margin-top:6px}' +
    '.b{border:1px solid #d4d4d8;background:#fff;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;color:#18181b}.b.primary{background:' + color + ';border-color:' + color + ';color:#fff;font-weight:600}' +
    '.check{display:flex;gap:6px;align-items:flex-start;font-weight:400;margin-top:10px}.check input{width:auto;margin-top:2px}' +
    'pre{white-space:pre-wrap;word-break:break-word;background:#f4f4f5;border-radius:6px;padding:6px;font-size:11px;max-height:110px;overflow:auto;margin:4px 0 0}' +
    'canvas{width:100%;border:1px solid #d4d4d8;border-radius:8px;margin-top:8px;cursor:crosshair;touch-action:none}' +
    '.err{color:#b91c1c;margin-top:6px}.hp{position:absolute;left:-9999px}' +
    '</style>' +
    '<button class="btn" type="button" part="button"></button>' +
    '<div class="panel" hidden role="dialog" aria-label="Report a problem">' +
    '<h2>Report a problem</h2>' +
    '<form novalidate>' +
    '<label for="t">What went wrong?</label><input id="t" name="title" maxlength="200" required placeholder="The pay button does nothing">' +
    '<label for="d">Details (optional)</label><textarea id="d" name="description" maxlength="10000" placeholder="What did you do, what did you expect?"></textarea>' +
    '<label for="e">Your email (optional, to hear when it\'s fixed)</label><input id="e" name="email" type="email" maxlength="254">' +
    '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
    '<div class="row"><button class="b" type="button" data-act="capture">Screenshot this page</button><button class="b" type="button" data-act="file">Attach an image</button><input type="file" accept="image/png,image/jpeg" hidden></div>' +
    '<div class="shot" hidden><canvas></canvas><div class="row"><span class="small">Drag on the picture to mark what matters.</span><button class="b" type="button" data-act="clear">Clear marks</button><button class="b" type="button" data-act="drop">Remove picture</button></div></div>' +
    '<div class="console" hidden><label class="check"><input type="checkbox" name="console"> <span>Include this page\'s recent console errors (<b class="n"></b>). These would be sent:</span></label><pre></pre></div>' +
    '<p class="small">Also sent: this page\'s address (without anything after "?"), your browser and window size.</p>' +
    '<div class="err" role="alert"></div>' +
    '<div class="row"><button class="b primary" type="submit">Send report</button><button class="b" type="button" data-act="close">Cancel</button></div>' +
    '</form></div>';

  var $ = function (sel) { return root.querySelector(sel); };
  var btn = $('.btn');
  var panel = $('.panel');
  var form = $('form');
  var canvas = $('canvas');
  var ctx = canvas.getContext('2d');
  var fileInput = $('input[type=file]');
  var image = null; // the picture before marks
  var marks = [];
  btn.textContent = label;

  function openPanel() {
    panel.hidden = false;
    var box = $('.console');
    box.hidden = errors.length === 0;
    $('.n').textContent = String(errors.length);
    $('pre').textContent = errors.map(function (e) { return e.message; }).join('\n');
    $('#t').focus();
  }
  function closePanel() { panel.hidden = true; }
  btn.addEventListener('click', function () { panel.hidden ? openPanel() : closePanel(); });

  // ---- Picture and marks.
  function draw() {
    if (!image) return;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    ctx.lineWidth = Math.max(3, canvas.width / 300);
    ctx.strokeStyle = '#ef4444';
    marks.forEach(function (m) { ctx.strokeRect(m.x, m.y, m.w, m.h); });
  }
  function setImage(source, w, h) {
    var scale = Math.min(1, 1600 / w);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    var c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    image = c;
    marks = [];
    $('.shot').hidden = false;
    draw();
  }
  var start = null;
  function pos(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  }
  canvas.addEventListener('pointerdown', function (e) { start = pos(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', function (e) {
    if (!start) return;
    var p = pos(e);
    draw();
    ctx.strokeRect(start.x, start.y, p.x - start.x, p.y - start.y);
  });
  canvas.addEventListener('pointerup', function (e) {
    if (!start) return;
    var p = pos(e);
    if (Math.abs(p.x - start.x) > 4 && Math.abs(p.y - start.y) > 4) marks.push({ x: start.x, y: start.y, w: p.x - start.x, h: p.y - start.y });
    start = null;
    draw();
  });

  function capture() {
    var md = navigator.mediaDevices;
    if (!md || !md.getDisplayMedia) { showError('This browser cannot take screenshots. Attach an image instead.'); return; }
    panel.hidden = true;
    btn.hidden = true;
    md.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true }).then(function (stream) {
      var video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      return video.play().then(function () {
        return new Promise(function (r) { setTimeout(r, 300); });
      }).then(function () {
        setImage(video, video.videoWidth, video.videoHeight);
        stream.getTracks().forEach(function (t) { t.stop(); });
      });
    }).catch(function () { showError('No screenshot taken.'); }).then(function () { btn.hidden = false; panel.hidden = false; });
  }
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) { showError('Attach a PNG or JPEG image.'); return; }
    var img = new Image();
    img.onload = function () { setImage(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(f);
  });

  panel.addEventListener('click', function (e) {
    var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'close') closePanel();
    if (act === 'capture') capture();
    if (act === 'file') fileInput.click();
    if (act === 'clear') { marks = []; draw(); }
    if (act === 'drop') { image = null; marks = []; $('.shot').hidden = true; fileInput.value = ''; }
  });

  function showError(msg) { $('.err').textContent = msg || ''; }

  function picture() {
    if (!image) return undefined;
    draw();
    var png = canvas.toDataURL('image/png');
    return png.length < 3900000 ? png : canvas.toDataURL('image/jpeg', 0.85);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    var title = form.title.value.trim();
    if (title.length < 3) { showError('Give the problem a short title.'); return; }
    var send = $('button[type=submit]');
    send.disabled = true;
    send.textContent = 'Sending…';
    var body = {
      title: title,
      description: form.description.value.trim(),
      email: form.email.value.trim() || undefined,
      website: form.website.value || undefined,
      page: { url: location.href, title: document.title.slice(0, 300), viewport: window.innerWidth + 'x' + window.innerHeight },
      consoleErrors: form.console && form.console.checked ? errors.slice() : [],
      screenshot: picture(),
    };
    fetch(endpoint, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' }, credentials: 'omit' })
      .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error((r.j && r.j.error && r.j.error.message) || 'The report could not be sent.');
        form.reset();
        image = null; marks = []; $('.shot').hidden = true;
        panel.querySelector('h2').textContent = 'Thanks! Your reference is ' + r.j.reference;
        setTimeout(function () { closePanel(); panel.querySelector('h2').textContent = 'Report a problem'; }, 4000);
      })
      .catch(function (err) { showError(err.message || 'The report could not be sent.'); })
      .then(function () { send.disabled = false; send.textContent = 'Send report'; });
  });

  function mount() { document.body.appendChild(host); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
