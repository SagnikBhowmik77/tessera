/* eslint-disable react-refresh/only-export-components */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { StainedWindow } from '../ds/core.jsx';

// The cinematic layer, used only where a first impression matters: sign-in and sign-up, invites,
// the public report page, empty states and the "not here" page. Working screens stay calm.
//
// HeroWindow: the stained-glass window. The static SVG is always drawn first (no layout shift, no
// wait); the live canvas (MosaicCanvas, its own small download) is laid over it only when motion
// is allowed and the device looks able, and it steps back to the SVG if frames run slow.
//
// CinematicVideo: a slot for real footage. Clips are files in src/media/ (see README there). If
// the files are not there, nothing is requested and the code-drawn window stays. If they are,
// the clip is muted, loops, loads only when near the screen, pauses off-screen and in a hidden
// tab, and is replaced by its poster for reduced motion or data saving.

const MosaicCanvas = lazy(() => import('./MosaicCanvas.jsx'));

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// Low-power or low-data devices get the picture, not the animation.
const lowPower = () => {
  const n = navigator;
  return Boolean(n.connection?.saveData) || (n.deviceMemory && n.deviceMemory <= 2) || (n.hardwareConcurrency && n.hardwareConcurrency <= 2);
};

function useMotionAllowed() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const q = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setOk(!reducedMotion() && !lowPower());
    // After first paint and idle time, so the live window never delays the page itself.
    const later = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
    const id = later(update);
    q?.addEventListener?.('change', update);
    return () => { (window.cancelIdleCallback ?? clearTimeout)(id); q?.removeEventListener?.('change', update); };
  }, []);
  return ok;
}

export function HeroWindow({ seed = 7, width = 100, height = 120, missing = -1, video, className, frameClassName }) {
  const allowed = useMotionAllowed();
  const [slow, setSlow] = useState(false);
  const [ready, setReady] = useState(false);
  const onSlow = useCallback(() => setSlow(true), []);
  const onReady = useCallback(() => setReady(true), []);
  const live = allowed && !slow;
  const footage = video ? clip(video) : null;
  return (
    <div className={clsx('relative isolate overflow-hidden', className)} data-mosaic={footage ? 'video' : live ? (ready ? 'live' : 'starting') : 'static'}>
      <StainedWindow seed={seed} width={width} height={height} missing={missing} className={clsx('size-full transition-opacity duration-(--dur-slow)', frameClassName, live && ready && 'opacity-0')} />
      {live && !footage && (
        <Suspense fallback={null}>
          <div className={clsx('absolute inset-0 transition-opacity duration-(--dur-slow)', frameClassName, ready ? 'opacity-100' : 'opacity-0')}>
            <MosaicCanvas seed={seed} width={width} height={height} missing={missing} onSlow={onSlow} onReady={onReady} />
          </div>
        </Suspense>
      )}
      {footage && <CinematicVideo name={video} className={clsx('absolute inset-0', frameClassName)} />}
    </div>
  );
}

// Clips found in src/media at build time: { 'login-hero': { webm, mp4, poster } }.
const FILES = import.meta.glob('../media/*.{webm,mp4,jpg,webp}', { eager: true, query: '?url', import: 'default' });
const CLIPS = {};
for (const [path, url] of Object.entries(FILES)) {
  const [, name, ext] = /\/([\w-]+)\.(\w+)$/.exec(path) ?? [];
  if (!name) continue;
  CLIPS[name] ??= {};
  CLIPS[name][ext === 'jpg' || ext === 'webp' ? 'poster' : ext] = url;
}
export const clip = (name) => (CLIPS[name]?.webm || CLIPS[name]?.mp4 ? CLIPS[name] : null);

export function CinematicVideo({ name, className, overlay = false }) {
  const c = clip(name);
  const box = useRef(null);
  const vid = useRef(null);
  const [near, setNear] = useState(false);
  const still = reducedMotion() || Boolean(navigator.connection?.saveData);
  // Start loading a little before it scrolls in.
  useEffect(() => {
    if (!c || still) return undefined;
    const load = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setNear(true); load.disconnect(); } }, { rootMargin: '200px' });
    load.observe(box.current);
    return () => load.disconnect();
  }, [c, still]);
  // Once the <video> exists: play while at least a quarter of it shows and the tab is open,
  // pause otherwise. (Set up after it mounts; an observer made earlier would find no video.)
  useEffect(() => {
    if (!c || still || !near) return undefined;
    const v = vid.current;
    let onScreen = false;
    const apply = () => { if (onScreen && !document.hidden) v.play().catch(() => {}); else v.pause(); };
    const seen = new IntersectionObserver(([e]) => { onScreen = e.intersectionRatio >= 0.25; apply(); }, { threshold: [0, 0.25] });
    seen.observe(box.current);
    document.addEventListener('visibilitychange', apply);
    return () => { seen.disconnect(); document.removeEventListener('visibilitychange', apply); };
  }, [c, still, near]);
  if (!c) return null;
  return (
    <div ref={box} className={clsx('overflow-hidden', className)}>
      {still || !near ? (
        c.poster && <img src={c.poster} alt="" aria-hidden className="size-full object-cover" decoding="async" loading="lazy" />
      ) : (
        <video ref={vid} muted loop playsInline preload="metadata" poster={c.poster} aria-hidden className="size-full object-cover">
          {c.webm && <source src={c.webm} type="video/webm" />}
          {c.mp4 && <source src={c.mp4} type="video/mp4" />}
        </video>
      )}
      {/* Anything written over footage sits on this, so the text never depends on the frame. */}
      {overlay && <div aria-hidden className="absolute inset-0 bg-linear-to-t from-canvas via-canvas/70 to-canvas/10" />}
    </div>
  );
}
