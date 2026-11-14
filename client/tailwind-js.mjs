// Tailwind CSS v4 for Vite without the native file scanner.
//
// @tailwindcss/vite finds the class names you use with a native add-on (@tailwindcss/oxide).
// Windows Smart App Control blocks that unsigned binary, and then Vite hangs with no output.
// Generating the CSS is plain JavaScript (@tailwindcss/node), so this plugin does the same job
// with a JavaScript scanner instead: every source file is split into candidate tokens, and
// Tailwind keeps the ones that are real utilities (anything else is ignored, so scanning
// generously costs nothing). Same Tailwind, same CSS, nothing native.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { compile, optimize } from '@tailwindcss/node';

const SOURCE = /\.(jsx?|tsx?|mdx?|html)$/;
// Class names never contain whitespace, quotes, backticks or braces; everything else
// (brackets, parentheses, colons, slashes, commas in arbitrary values) can be part of one.
const SPLIT = /[\s"'`{}]+/;

function tokensOf(text) {
  const out = new Set();
  for (const raw of text.split(SPLIT)) {
    if (!raw || raw.length > 200) continue;
    out.add(raw);
    // "b)" or "c," at the end of an expression: also try it without the trailing punctuation.
    const trimmed = raw.replace(/[),;]+$/, '');
    if (trimmed && trimmed !== raw) out.add(trimmed);
  }
  return out;
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (SOURCE.test(name)) files.push(full);
  }
  return files;
}

export default function tailwindJs({ sources = ['src', 'index.html'] } = {}) {
  let config;
  let root;
  const byFile = new Map(); // file -> Set of tokens
  const cssIds = new Set(); // CSS modules that import tailwindcss (refreshed when classes change)
  const candidates = () => {
    const all = new Set();
    for (const set of byFile.values()) for (const t of set) all.add(t);
    return [...all];
  };
  const scan = (file) => {
    try { byFile.set(path.normalize(file), tokensOf(readFileSync(file, 'utf8'))); } catch { byFile.delete(path.normalize(file)); }
  };
  const scanAll = () => {
    byFile.clear();
    for (const s of sources) {
      const full = path.resolve(root, s);
      try {
        if (statSync(full).isDirectory()) walk(full).forEach(scan);
        else scan(full);
      } catch { /* a listed source that doesn't exist is skipped */ }
    }
  };
  const isSource = (file) => SOURCE.test(file) && sources.some((s) => path.normalize(file).startsWith(path.resolve(root, s)));

  return {
    name: 'tailwind-js',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
      root = resolved.root;
    },
    buildStart() {
      scanAll();
    },
    async transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.css') || !/@import\s+['"]tailwindcss['"]/.test(code)) return null;
      cssIds.add(id);
      const compiler = await compile(code, {
        base: path.dirname(file),
        onDependency: (dep) => this.addWatchFile(dep),
      });
      let css = compiler.build(candidates());
      // Same as @tailwindcss/vite: lower modern syntax for the production bundle.
      if (config.command === 'build') css = optimize(css, { minify: false }).code;
      return { code: css, map: null };
    },
    // Dev: a saved component may use new classes, so its CSS is rebuilt and hot-updated.
    handleHotUpdate({ file, server, modules }) {
      if (!isSource(file)) return undefined;
      const before = byFile.get(path.normalize(file));
      scan(file);
      const after = byFile.get(path.normalize(file));
      const added = after && [...after].some((t) => !before?.has(t));
      if (!added) return undefined;
      const cssModules = [...cssIds].map((cid) => server.moduleGraph.getModuleById(cid)).filter(Boolean);
      for (const m of cssModules) server.moduleGraph.invalidateModule(m);
      return [...modules, ...cssModules];
    },
  };
}
