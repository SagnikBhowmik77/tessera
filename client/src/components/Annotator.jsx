import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowUpRight, Eraser, Grid2x2, Square, Undo2 } from 'lucide-react';
import { Button, Modal } from './ui.jsx';

// Mark up a screenshot before it is uploaded: boxes, arrows, and blur for secrets.
// Everything happens in the browser; only the finished picture is sent. Blurred areas
// are replaced pixel by pixel in the saved image, so the hidden text is not in the file.
const RED = '#ef4444';

function pixelate(ctx, img, x, y, w, h) {
  if (w < 2 || h < 2) return;
  const block = Math.max(12, Math.round(Math.min(w, h) / 5));
  const sw = Math.max(1, Math.ceil(w / block));
  const sh = Math.max(1, Math.ceil(h / block));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  small.getContext('2d').drawImage(img, x, y, w, h, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, sw, sh, x, y, w, h);
  ctx.imageSmoothingEnabled = true;
}

function drawShape(ctx, img, s, lw) {
  const x = Math.min(s.x1, s.x2);
  const y = Math.min(s.y1, s.y2);
  const w = Math.abs(s.x2 - s.x1);
  const h = Math.abs(s.y2 - s.y1);
  ctx.strokeStyle = RED;
  ctx.fillStyle = RED;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  if (s.tool === 'blur') pixelate(ctx, img, x, y, w, h);
  if (s.tool === 'box') ctx.strokeRect(x, y, w, h);
  if (s.tool === 'arrow') {
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = lw * 5;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2 - Math.cos(angle) * head * 0.6, s.y2 - Math.sin(angle) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 7), s.y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 7), s.y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  }
}

const TOOLS = [
  { key: 'box', label: 'Box', Icon: Square },
  { key: 'arrow', label: 'Arrow', Icon: ArrowUpRight },
  { key: 'blur', label: 'Blur', Icon: Grid2x2 },
];

export default function Annotator({ file, onDone, onCancel }) {
  const canvas = useRef(null);
  const draft = useRef(null);
  const [img, setImg] = useState(null);
  const [shapes, setShapes] = useState([]);
  const [tool, setTool] = useState('box');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const render = useCallback((list) => {
    const c = canvas.current;
    if (!c || !img) return;
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const lw = Math.max(3, Math.round(img.naturalWidth / 320));
    for (const s of list) drawShape(ctx, img, s, lw);
  }, [img]);
  useEffect(() => { render(shapes); }, [render, shapes]);

  const point = (e) => {
    const c = canvas.current;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };
  const down = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    draft.current = { tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  };
  const move = (e) => {
    if (!draft.current) return;
    const p = point(e);
    draft.current = { ...draft.current, x2: p.x, y2: p.y };
    render([...shapes, draft.current]);
  };
  const up = () => {
    const s = draft.current;
    draft.current = null;
    if (s && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 6) setShapes((list) => [...list, s]);
    else render(shapes);
  };

  const save = () => {
    setSaving(true);
    canvas.current.toBlob((blob) => {
      const base = file.name.replace(/\.[^.]+$/, '') || 'screenshot';
      onDone(new File([blob], `${base}-marked.png`, { type: 'image/png' }));
    }, 'image/png');
  };

  return (
    <Modal
      open
      wide
      onClose={onCancel}
      title="Mark up the screenshot"
      footer={(
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onDone(file)}>Upload as it is</Button>
          <Button variant="primary" disabled={!shapes.length} loading={saving} onClick={save}>Upload with marks</Button>
        </>
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {TOOLS.map(({ key, label, Icon }) => (
          <Button key={key} size="sm" variant={tool === key ? 'primary' : 'secondary'} onClick={() => setTool(key)} aria-pressed={tool === key}>
            <Icon className="size-3.5" />{label}
          </Button>
        ))}
        <span className="mx-1 h-4 w-px bg-press" />
        <Button size="sm" variant="ghost" disabled={!shapes.length} onClick={() => setShapes((l) => l.slice(0, -1))}><Undo2 className="size-3.5" />Undo</Button>
        <Button size="sm" variant="ghost" disabled={!shapes.length} onClick={() => setShapes([])}><Eraser className="size-3.5" />Clear</Button>
        <span className="ml-auto text-caption text-fg-subtle">Drag on the picture. Use Blur on passwords, emails and tokens.</span>
      </div>
      <div className="grid place-items-center rounded-tile bg-sunken p-2">
        {!img && <div className="h-48" />}
        <canvas
          ref={canvas}
          aria-label="Screenshot being marked up"
          className={clsx('max-h-[60vh] max-w-full touch-none', tool === 'blur' ? 'cursor-cell' : 'cursor-crosshair', !img && 'hidden')}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      </div>
    </Modal>
  );
}
