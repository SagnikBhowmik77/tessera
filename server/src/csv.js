// CSV in and out (RFC 4180): fields with commas, quotes or line breaks are quoted, quotes are
// doubled. Reading accepts a UTF-8 byte-order mark, CRLF or LF line ends, and quoted line breaks.

// Text -> array of rows (arrays of strings). Blank lines are dropped.
export function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error('A quoted field is never closed');
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

// A cell that a spreadsheet would run as a formula (=, +, -, @, tab, CR) gets a leading apostrophe,
// so opening an export in Excel or Sheets can never execute something a ticket author typed.
const FORMULA = /^[=+\-@\t\r]/;
const safe = (v) => {
  const text = v === null || v === undefined ? '' : String(v);
  return FORMULA.test(text) ? `'${text}` : text;
};
// Reading our own export back: drop that apostrophe again.
export const unsafe = (text) => (text.startsWith("'") && FORMULA.test(text.slice(1)) ? text.slice(1) : text);

const quote = (v) => {
  const text = safe(v);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// Array of rows -> CSV text with CRLF line ends and a byte-order mark (so Excel reads UTF-8).
export function toCsv(rows) {
  return `﻿${rows.map((r) => r.map(quote).join(',')).join('\r\n')}\r\n`;
}
