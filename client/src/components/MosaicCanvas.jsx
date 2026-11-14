import { useEffect, useRef } from 'react';
import { GLASS_STOPS, panes } from '../ds/core.jsx';

// The live stained-glass window: the same panes as <StainedWindow>, drawn on a canvas so they can
// answer the cursor. Near the pointer, panes lift, lean away from it and glow; a click sends a
// ripple of light across the glass; while idle, a slow band of light drifts over it.
//
// Loaded on its own (React.lazy) by HeroWindow, which shows the static SVG first and only mounts
// this when motion is allowed and the device can afford it. It also watches itself: if frames
// run slow (median over 28 ms), it stops and says so, and HeroWindow falls back to the picture.
//
// Cost per frame is measured and kept on window.__tesseraMosaic (draw time, frame time, mode), so
// the 60 fps claim is checked by a test instead of assumed.

const glass = (t) => {
  const u = Math.min(Math.max(t, 0), 1) * 2;
  const [a, b] = u < 1 ? [GLASS_STOPS[0], GLASS_STOPS[1]] : [GLASS_STOPS[1], GLASS_STOPS[2]];
  const k = u < 1 ? u : u - 1;
  return a.map((v, i) => Math.round(v + (b[i] - v) * k));
};

export default function MosaicCanvas({ seed = 7, width = 100, height = 120, missing = -1, onSlow, onReady }) {
  const canvas = useRef(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el.getContext('2d');
    const list = panes(seed, width, height).map((p, i) => {
      const t = (p.x + p.w / 2) / width * 0.55 + (p.y + p.h / 2) / height * 0.45;
      return { ...p, i, cx: p.x + p.w / 2, cy: p.y + p.h / 2, rgb: glass(t), clear: p.r < 0.14 || i === missing, gone: i === missing, lift: 0 };
    });
    const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    let line = css('--c-line-strong', '#888');
    let accent = css('--c-accent', '#c2305a');
    const theme = new MutationObserver(() => { line = css('--c-line-strong', line); accent = css('--c-accent', accent); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Size: the canvas covers its box (like the SVG's "slice"), sharp on high-density screens.
    let scale = 1;
    let ox = 0;
    let oy = 0;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = Math.max(1, Math.round(r.width * dpr));
      el.height = Math.max(1, Math.round(r.height * dpr));
      scale = Math.max(r.width / width, r.height / height) * dpr;
      ox = (el.width - width * scale) / 2;
      oy = (el.height - height * scale) / 2;
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(el);

    // The pointer in pane units; null when it is not over the window.
    let pointer = null;
    const ripples = [];
    const toPane = (e) => {
      const r = el.getBoundingClientRect();
      const dpr = el.width / r.width;
      return { x: ((e.clientX - r.left) * dpr - ox) / scale, y: ((e.clientY - r.top) * dpr - oy) / scale };
    };
    const move = (e) => { pointer = toPane(e); };
    const leave = () => { pointer = null; };
    const down = (e) => { ripples.push({ ...toPane(e), at: performance.now() }); if (ripples.length > 4) ripples.shift(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerdown', down);

    const reach = Math.max(width, height) * 0.32;
    const gap = 1.1;
    const stats = { mode: 'live', frames: 0, draw: [], frame: [] };
    window.__tesseraMosaic = stats;

    const draw = (now) => {
      const t0 = performance.now();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);
      // The idle light: a soft diagonal band crossing the window every nine seconds.
      const sweep = ((now / 9000) % 1) * 1.6 - 0.3;
      for (const p of list) {
        let target = 0;
        let dx = 0;
        let dy = 0;
        if (pointer) {
          dx = p.cx - pointer.x;
          dy = p.cy - pointer.y;
          const d = Math.hypot(dx, dy);
          target = Math.max(0, 1 - d / reach) ** 1.6;
        }
        for (const r of ripples) {
          const age = (now - r.at) / 1000;
          const ring = age * reach * 2.4;
          const d = Math.hypot(p.cx - r.x, p.cy - r.y);
          const hit = Math.max(0, 1 - Math.abs(d - ring) / (reach * 0.35)) * Math.max(0, 1 - age / 1.4);
          target = Math.max(target, hit);
        }
        // Ease towards the target, so panes settle instead of snapping.
        p.lift += (target - p.lift) * 0.18;
        const band = Math.max(0, 1 - Math.abs((p.cx / width) * 0.6 + (p.cy / height) * 0.4 - sweep) / 0.14) * 0.22;
        const glow = Math.min(1, p.lift + band);

        const len = Math.hypot(dx, dy) || 1;
        const push = p.lift * 0.9;
        const grow = 1 + p.lift * 0.05;
        const w = Math.max(p.w - gap, 0) * grow;
        const h = Math.max(p.h - gap, 0) * grow;
        const x = p.cx + (dx / len) * push - w / 2;
        const y = p.cy + (dy / len) * push - h / 2;
        // Lean away from the pointer: a small shear, like a pane tipped in its lead.
        const lean = p.lift * 0.06;
        ctx.setTransform(scale, (dy / len) * lean * scale * 0.2, (dx / len) * lean * scale * 0.2, scale, ox, oy);

        if (p.clear) {
          // The missing pane (404): an accent outline that breathes, brighter as the cursor nears.
          const breathe = p.gone ? 0.55 + 0.25 * Math.sin(now / 700) + p.lift * 0.4 : 0;
          ctx.shadowBlur = p.gone ? breathe * 10 * (scale / 3) : 0;
          ctx.shadowColor = accent;
          ctx.globalAlpha = p.gone ? Math.min(1, breathe + 0.2) : 0.9;
          ctx.strokeStyle = p.gone ? accent : line;
          ctx.lineWidth = p.gone ? 0.7 : 0.35;
          ctx.setLineDash([1.2, 1]);
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, 1.2);
          ctx.stroke();
          ctx.setLineDash([]);
          continue;
        }
        const [r, g, b] = p.rgb;
        ctx.globalAlpha = Math.min(1, 0.32 + p.r * 0.68 + glow * 0.45);
        if (glow > 0.08) {
          ctx.shadowColor = `rgb(${r} ${g} ${b})`;
          ctx.shadowBlur = glow * 18 * (scale / 3);
        } else ctx.shadowBlur = 0;
        ctx.fillStyle = `rgb(${Math.min(255, r + glow * 40)} ${Math.min(255, g + glow * 40)} ${Math.min(255, b + glow * 40)})`;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 1.2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      while (ripples.length && now - ripples[0].at > 1600) ripples.shift();
      return performance.now() - t0;
    };

    // Run only while the window can be seen and the tab is open.
    let raf = 0;
    let last = 0;
    let visible = true;
    const loop = (now) => {
      const cost = draw(now);
      if (last) {
        stats.frame.push(now - last);
        stats.draw.push(cost);
        if (stats.frame.length > 120) { stats.frame.shift(); stats.draw.shift(); }
      }
      last = now;
      stats.frames += 1;
      if (stats.frames === 1) onReady?.();
      // Too slow for this device: stop, and let the static picture stand.
      if (stats.frames === 150) {
        const sorted = [...stats.frame].sort((a, b) => a - b);
        if (sorted[Math.floor(sorted.length / 2)] > 28) { stats.mode = 'static (slow device)'; onSlow?.(); return; }
      }
      raf = requestAnimationFrame(loop);
    };
    const start = () => { if (!raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(loop); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const seen = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); else stop(); });
    seen.observe(el);
    const tab = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', tab);
    start();

    return () => {
      stop();
      seen.disconnect();
      resize.disconnect();
      theme.disconnect();
      document.removeEventListener('visibilitychange', tab);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', down);
    };
  }, [seed, width, height, missing, onSlow, onReady]);

  return <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full touch-pan-y" />;
}
