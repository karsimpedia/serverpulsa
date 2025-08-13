// api/lib/invoice-id.js

// Generator invoice ID yang ringkas, berurutan, dan kecil kemungkinan bentrok.
// Format: INV-YYYYMMDD-<TS36>-<SEQ><RAND>
// Contoh: INV-20250813-LY2GZ0-07K9
let __lastMs = 0;
let __seq = 0;

const toJakartaDate = () =>
  new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));

/**
 * Hasil contoh:
 *   INV-20250813-LY2GZ0-07K9
 */
export function genInvoiceId(prefix = 'INV') {
  const nowMs = Date.now();
  if (nowMs === __lastMs) {
    __seq = (__seq + 1) & 0xff; // 0..255
  } else {
    __lastMs = nowMs;
    __seq = 0;
  }

  const d = toJakartaDate();
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const datePart = `${YYYY}${MM}${DD}`;

  const ts36 = nowMs.toString(36).toUpperCase();            // cap waktu base36
  const seqPart = __seq.toString(36).toUpperCase().padStart(2, '0');
  const randPart = Math.random().toString(36).slice(2, 4).toUpperCase(); // 2 char

  return `${prefix}-${datePart}-${ts36}-${seqPart}${randPart}`;
}
