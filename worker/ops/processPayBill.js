// worker/ops/processPayBill.js
import prisma from '../../api/prisma.js';
import { pickCandidatesForWorker } from '../../utils/supplierPicker.js';
import { callSupplier } from '../../api/lib/supplier-client.js';
import { finalizeSuccess, finalizeFailed } from '../../api/lib/finalize.js';
import { pushTrxUpdate } from '../utils/socket.js';

const onlyDigits = (v) => (v == null ? undefined : String(v).replace(/[^\d]/g, '') || undefined);

const SERIAL_KEYS = [
  'serial', 'sn', 'serialNo', 'serial_number',
  'voucherCode', 'voucher_code',
  'token', 'token1', 'token2', 'payToken', 'plnToken'
];

function deepFindByKeys(obj, keys, depth = 0) {
  if (!obj || depth > 6) return undefined;
  if (typeof obj !== 'object') return undefined;

  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (keys.includes(k)) {
      if (v != null && v !== '' && typeof v !== 'object') return String(v);
      if (Array.isArray(v) && v.length) {
        const joined = v.filter(x => x != null && typeof x !== 'object').join(' ');
        if (joined) return String(joined);
      }
    }
    if (v && typeof v === 'object') {
      const found = deepFindByKeys(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export async function processPayBill(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: true }
  });
  if (!trx) throw new Error('Transaksi tidak ditemukan');
  if (trx.product?.type !== 'TAGIHAN') throw new Error('Transaksi bukan TAGIHAN');

  // Terima WAITING/PENDING/PROCESSING
  if (!['WAITING', 'PENDING', 'PROCESSING'].includes(trx.status)) {
    return { skip: `not-eligible(${trx.status})` };
  }

  const candidates = await pickCandidatesForWorker(trx.productId);
  if (!candidates.length) {
    await finalizeFailed(trxId, { message: 'NO_SUPPLIER', supplierResult: { error: 'no supplier' } });
    pushTrxUpdate(trxId, { status: 'FAILED', message: 'NO_SUPPLIER' });
    return;
  }

  // Tandai PENDING ketika mulai dispatch pertama kali
  if (trx.status === 'WAITING') {
    try {
      await prisma.transaction.update({
        where: { id: trxId },
        data: { status: 'PENDING', message: 'PENDING (dispatch to supplier)' }
      });
      pushTrxUpdate(trxId, { status: 'PENDING', message: 'PENDING (dispatch to supplier)' });
      trx.status = 'PENDING';
    } catch { /* noop */ }
  }

  // Snapshot request
  const reqSnap = trx.supplierPayload?.request || {};
  const idNumber   = reqSnap.idNumber ?? trx.msisdn;
  const dest       = reqSnap.dest ?? trx.msisdn;
  const amountPref = reqSnap.amount ?? trx.amountDue;
  const amountStr  = onlyDigits(amountPref);

  let lastErr = null;

  for (const c of candidates) {
    try {
      const ctx = {
        baseUrl: c.ep.baseUrl,
        apiKey: c.ep.apiKey || undefined,
        secret: c.ep.secret || undefined,
        ref: trx.invoiceId,
        product: trx.supplierPayload?.supplierSku || c.sp?.supplierSku || null,
        customerNo: String(idNumber || ''), // Nomor ID
        msisdn: String(dest || ''),        // Nomor Tujuan (jika vendor pakai)
        ...(amountStr ? { amount: amountStr } : {}), // Open denom (opsional)
      };

      const res = await callSupplier('paybill', c.supplierCode, ctx);
      if (!res.ok) { lastErr = res.error || 'transport'; continue; }

      // Ambil serial (SN/token) bila ada
      const serialFromNorm = res.norm?.extra?.serial;
      const serialFromRaw  = deepFindByKeys(res.data, SERIAL_KEYS);
      const serial = (serialFromNorm || serialFromRaw) ? String(serialFromNorm || serialFromRaw).slice(0, 512) : undefined;

      // Simpan supplierRef, raw, dan serial (jika ada) — tanpa serialAt
      await prisma.transaction.update({
        where: { id: trxId },
        data: {
          supplierRef: res.norm?.supplierRef ?? trx.supplierRef ?? null,
          supplierResult: res.data,
          ...(serial ? { serial } : {})
        }
      });

      const st  = String(res.norm?.status || '').toUpperCase();
      const msg = res.norm?.message || st || 'PROCESSING';

      if (st === 'SUCCESS') {
        await finalizeSuccess(trxId, { message: res.norm?.message || 'SUCCESS', supplierResult: res.data });
        pushTrxUpdate(trxId, { status: 'SUCCESS', message: res.norm?.message || 'SUCCESS', ...(serial ? { serial } : {}) });
        return;
      }

      if (['FAILED', 'CANCELED', 'EXPIRED'].includes(st)) {
        await finalizeFailed(trxId, { message: res.norm?.message || st, supplierResult: res.data });
        pushTrxUpdate(trxId, { status: st, message: res.norm?.message || st });
        return;
      }

      // PENDING/PROCESSING → tunggu callback/polling; serial jika ada tetap dikirim dalam update
      await prisma.transaction.update({
        where: { id: trxId },
        data: { status: 'PROCESSING', message: msg }
      });
      pushTrxUpdate(trxId, { status: 'PROCESSING', message: msg, ...(serial ? { serial } : {}) });
      return;
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }

  await finalizeFailed(trxId, { message: lastErr || 'ALL_SUPPLIER_FAILED', supplierResult: { error: lastErr } });
  pushTrxUpdate(trxId, { status: 'FAILED', message: lastErr || 'ALL_SUPPLIER_FAILED' });
}
