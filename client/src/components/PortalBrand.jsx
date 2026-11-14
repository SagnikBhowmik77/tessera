import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ImagePlus, Trash2 } from 'lucide-react';
import { api, apiBlob } from '../lib/api.js';
import { accentStyle } from '../lib/accents.js';
import { Button, Field, Input } from '../ds/core.jsx';
import { ProjectTile } from './ProjectTile.jsx';
import AccentPicker from './AccentPicker.jsx';

const MAX_LOGO = 256 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// The team's own logo while setting up (the public address only works once the page is on).
function useLogoPreview(projectId, version) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!version) { setSrc(null); return undefined; }
    let url;
    let live = true;
    apiBlob(`/projects/${projectId}/portal/logo`).then((blob) => { if (live) { url = URL.createObjectURL(blob); setSrc(url); } }).catch(() => setSrc(null));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [projectId, version]);
  return src;
}

// How the public report page looks: the name on it, one accent colour and the team's logo, with
// a preview of the page's header in the chosen colour. Each change saves on its own.
export default function PortalBrand({ project, portal, disabled }) {
  const qc = useQueryClient();
  const [name, setName] = useState(null);
  const [busy, setBusy] = useState(false);
  const file = useRef(null);
  const brand = portal.brand ?? { name: '', accent: null, logo: null };
  const logo = useLogoPreview(project.id, brand.logo);
  const shownName = (name ?? brand.name) || project.name;

  const save = async (body, what) => {
    try {
      const r = await api(`/projects/${project.id}/portal`, { method: 'PUT', body: { brand: body } });
      qc.setQueryData(['portal', project.id], r.portal);
      toast.success(`${what} saved`);
      return true;
    } catch (e) { toast.error(`Couldn't save the ${what.toLowerCase()}: ${e.message}`); return false; }
  };
  const upload = async (f) => {
    if (!f) return;
    if (!TYPES.includes(f.type)) { toast.error("Couldn't use that file: the logo must be a PNG, JPEG or WebP image."); return; }
    if (f.size > MAX_LOGO) { toast.error(`Couldn't use that file: it is ${Math.ceil(f.size / 1024)} KB, and the logo can be up to 256 KB.`); return; }
    setBusy(true);
    const form = new FormData();
    form.append('file', f);
    try {
      const r = await api(`/projects/${project.id}/portal/logo`, { method: 'PUT', form });
      qc.setQueryData(['portal', project.id], r.portal);
      toast.success('Logo saved');
    } catch (e) { toast.error(`Couldn't save the logo: ${e.message}`); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  };
  const removeLogo = async () => {
    try {
      const r = await api(`/projects/${project.id}/portal/logo`, { method: 'DELETE' });
      qc.setQueryData(['portal', project.id], r.portal);
      toast.success('Logo removed');
    } catch (e) { toast.error(`Couldn't remove the logo: ${e.message}`); }
  };

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="text-small font-semibold text-fg">How the page looks</h3>
      <p className="mt-0.5 text-caption text-fg-subtle">Reporters see your name, colour and logo. Everything else stays the same.</p>

      {/* The page's header as reporters will see it, in the chosen colour. */}
      <div className="ds-accented mt-4 flex items-center gap-3 rounded-card border border-line bg-canvas px-4 py-3" style={accentStyle(brand.accent)} role="group" aria-label="Preview of the page header">
        {logo ? <img src={logo} alt="" className="size-9 rounded-tile object-contain" /> : <ProjectTile project={{ ...project, name: shownName }} className="size-9 text-caption" />}
        <span className="min-w-0 flex-1 truncate text-small font-semibold text-fg">{shownName}</span>
        <span aria-hidden className="ds-gradient rounded-tile px-3 py-1.5 text-caption font-medium text-on-gradient">Send report</span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Name on the page" hint={`Leave it empty to use “${project.name}”.`}>
          <div className="flex gap-2">
            <Input value={name ?? brand.name} maxLength={60} placeholder={project.name} onChange={(e) => setName(e.target.value)} disabled={disabled} />
            {name !== null && name !== brand.name && <Button variant="primary" onClick={async () => { if (await save({ name }, 'Name')) setName(null); }}>Save</Button>}
          </div>
        </Field>

        <div>
          <span className="mb-1.5 block text-small font-medium text-fg">Logo</span>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={file} type="file" accept={TYPES.join(',')} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => upload(e.target.files?.[0])} />
            <Button icon={ImagePlus} loading={busy} disabled={disabled} onClick={() => file.current?.click()}>{brand.logo ? 'Replace logo' : 'Upload logo'}</Button>
            {brand.logo && <Button variant="ghost" icon={Trash2} onClick={removeLogo} disabled={disabled}>Remove</Button>}
          </div>
          <p className="mt-1.5 text-caption text-fg-subtle">PNG, JPEG or WebP, up to 256 KB. A square image works best.</p>
        </div>
      </div>

      <fieldset className="mt-4" disabled={disabled}>
        <legend className="mb-1.5 text-small font-medium text-fg">Accent colour</legend>
        <AccentPicker value={brand.accent} onChange={(key) => save({ accent: key }, 'Colour')} disabled={disabled} />
        <p className="mt-1.5 text-caption text-fg-subtle">Every colour here passes WCAG AA contrast for text and buttons, in light and dark mode.</p>
      </fieldset>
    </div>
  );
}
