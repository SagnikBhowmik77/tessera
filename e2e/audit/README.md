# Audits

The strict review's measurements, kept so they can be run again.

## Lighthouse (performance, accessibility, best practices, SEO)

Login, the public report page, the board and analytics, in light and dark, with Lighthouse's
standard mobile settings (simulated slow 4G, 4× slower CPU). Each page is measured three times
from a cold start and the median run is reported.

```bash
npm --prefix ../server run e2e:api -- 8740       # throwaway in-memory API
npm --prefix ../client run build
node audit/serve.mjs 5213                        # the build, served like a real host
node audit/lighthouse.mjs <label>                # RUNS=5 for more runs
```

`audit/serve.mjs` compresses with Brotli, caches hashed files for a year and falls back to
`index.html`, as a production static host does (`vite preview` does none of that, which would
make the Performance score unfairly low). Reports land in `audit/reports/<label>/`.

## axe and the keyboard

```bash
AXE_REPORT=<label> npx playwright test --config visual/playwright.visual.config.js a11y
```

axe with every WCAG 2.0/2.1/2.2 A and AA rule, in light and dark, on the four pages above, the
states inside them (each portal step, the ticket drawer, a chart as a table) and the rest of the
signed-in app. Any violation fails the run. The same spec checks that every Tab stop shows a focus
ring, and that a card can be moved with the keyboard alone while the board says what is happening.

## What a page downloads

```bash
node audit/weigh.mjs <path> [token]
```

Lists every file a cold visit downloads, largest first (compressed sizes).
