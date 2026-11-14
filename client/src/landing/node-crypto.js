// The one piece of `node:crypto` the server's stack-trace parser uses (a SHA-1 fingerprint), for
// the browser. The landing page's demo runs the server's own parser (server/src/bugs/), and the
// client build points `node:crypto` here (vite.config.js), so the demo computes the same
// fingerprint the API would. SHA-1 is only a grouping key here, never a security measure.

function sha1Hex(bytes) {
  const words = [];
  const bitLen = bytes.length * 8;
  // Message, a 0x80 byte and the 8-byte length, rounded up to whole 64-byte blocks.
  const padded = new Uint8Array(((bytes.length + 8) >> 6 << 6) + 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i += 1) words[i] = rotl(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i += 1) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5A827999]
        : i < 40 ? [b ^ c ^ d, 0x6ED9EBA1]
          : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8F1BBCDC]
            : [b ^ c ^ d, 0xCA62C1D6];
      const t = (rotl(a, 5) + f + e + k + words[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

export function createHash(algorithm) {
  if (algorithm !== 'sha1') throw new Error(`Only sha1 is available in the browser (asked for ${algorithm})`);
  let text = '';
  return {
    update(chunk) { text += String(chunk); return this; },
    digest(encoding) {
      if (encoding !== 'hex') throw new Error('Only hex digests are available in the browser');
      return sha1Hex(new TextEncoder().encode(text));
    },
  };
}

export default { createHash };
