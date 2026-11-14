import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Tailwind v4 through a JavaScript-only plugin: Windows Smart App Control blocks the native
// scanner that @tailwindcss/vite loads (see tailwind-js.mjs). Same Tailwind, same CSS.
import tailwindcss from './tailwind-js.mjs';

// The API the dev / preview server forwards to (the browser tests point it at their own server).
const API = process.env.TESSERA_API_PROXY || 'http://localhost:8740';

// The faces every first screen uses (body text, and the serif titles upright and italic), asked
// for straight from the HTML. Otherwise they are only found once the CSS is parsed, arrive after
// the first paint, and the text reflows when they swap in (a layout shift). Built file names are
// hashed, so they are looked up in the bundle.
const PRELOAD_FONTS = [/geist-latin-wght-normal-[\w-]+\.woff2$/, /instrument-serif-latin-400-(normal|italic)-[\w-]+\.woff2$/];
function preloadFonts() {
  return {
    name: 'tessera-preload-fonts',
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        if (!bundle) return html;
        const files = Object.keys(bundle).filter((f) => PRELOAD_FONTS.some((re) => re.test(f)));
        return files.map((f) => ({ tag: 'link', injectTo: 'head', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${f}`, crossorigin: '' } }));
      },
    },
  };
}

// Link previews (Open Graph and X/Twitter). Crawlers want an absolute image address, so set
// SITE_URL (e.g. https://tessera.example.com) when building for a public host; without it the
// tags use site-relative paths, which most chat apps resolve but some crawlers ignore.
function socialMeta() {
  const site = (process.env.SITE_URL || '').replace(/\/+$/, '');
  const tags = {
    'og:type': 'website',
    'og:site_name': 'Tessera',
    'og:title': 'Tessera',
    'og:description': 'Issue tracking for teams who ship: boards, bug intelligence, flow analytics and live collaboration, in one window.',
    'og:image': `${site}/og.png`,
    'og:image:width': '1200',
    'og:image:height': '630',
    'og:image:alt': 'The Tessera mark, a window of four glass panes, beside a stained-glass mosaic.',
    'twitter:card': 'summary_large_image',
  };
  return {
    name: 'tessera-social-meta',
    transformIndexHtml: () => Object.entries(tags).map(([k, content]) => ({ tag: 'meta', injectTo: 'head', attrs: { [k.startsWith('og:') ? 'property' : 'name']: k, content } })),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadFonts(), socialMeta()],
  // The landing page's demos import the server's own pure modules (stack-trace parser, secret
  // redaction, the Monte Carlo forecast). The parser's one Node import gets a browser twin.
  resolve: { alias: { 'node:crypto': fileURLToPath(new URL('./src/landing/node-crypto.js', import.meta.url)) } },
  server: {
    port: 5210,
    strictPort: true,
    // Windows 8.3 short paths (SAGNIK~1) make Vite reject its own files otherwise.
    fs: { strict: false },
    // In dev the client calls /api/* and Socket.IO on its own origin; Vite forwards both to the API.
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  preview: {
    port: 5211,
    strictPort: true,
    proxy: { '/api': API, '/socket.io': { target: API, ws: true } },
  },
});
