// The accent colours a public report page can wear (portal branding), and later the account
// accent. Curated, not free: every step was checked (2026-11-13) to give at least 4.5:1 for text
// and links on the surface and the canvas, and for the button text on the accent itself:
//            light: on surface / canvas / white on it    dark: on surface / canvas / ink on it
//   violet   5.46 / 5.01 / 5.46                          6.79 / 7.17 / 6.97
//   rose     5.67 / 5.20 / 5.67                          7.63 / 8.06 / 7.84
//   amber    6.33 / 5.80 / 6.33                         10.21 / 10.78 / 10.48
//   green    5.44 / 4.99 / 5.44                         10.15 / 10.72 / 10.42
//   teal     5.59 / 5.12 / 5.59                          9.63 / 10.17 / 9.89
//   blue     5.71 / 5.24 / 5.71                          7.89 / 8.33 / 8.10
//   orange   5.75 / 5.27 / 5.75                          8.28 / 8.74 / 8.50
//   graphite 10.62 / 9.73 / 10.62                        11.30 / 11.94 / 11.60
// The keys match PORTAL_ACCENTS on the server.
export const ACCENTS = {
  violet: { name: 'Violet', light: '#6D4FE0', dark: '#A08AFF' },
  rose: { name: 'Rose', light: '#C4244C', dark: '#FF7A9C' },
  amber: { name: 'Amber', light: '#8A5300', dark: '#F7B23B' },
  green: { name: 'Green', light: '#11785A', dark: '#3DD6A0' },
  teal: { name: 'Teal', light: '#0B7285', dark: '#4FC9DE' },
  blue: { name: 'Blue', light: '#3361C7', dark: '#7AA7FF' },
  orange: { name: 'Orange', light: '#A84A0C', dark: '#F7934C' },
  graphite: { name: 'Graphite', light: '#3F3D4A', dark: '#C9C7D4' },
};

// Style for an element that should wear an accent: it sets both theme steps, and the
// .ds-accented class (ds/surfaces.css) picks the right one and re-tints links, focus rings,
// selected cards, the primary button and the page's light. Nothing when there is no accent.
export function accentStyle(key) {
  const a = ACCENTS[key];
  return a ? { '--accent-light': a.light, '--accent-dark': a.dark } : undefined;
}
