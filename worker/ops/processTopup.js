// worker/ops/processTopup.js
import prisma from '../../api/prisma.js';
import { pickCandidatesForWorker } from '../../utils/supplierPicker.js';
import { callSupplier } from '../../api/lib/supplier-client.js';
import { finalizeSuccess, finalizeFailed } from '../../api/lib/finalize.js';
import { pushTrxUpdate } from '../utils/socket.js';
import { awardPointsForSuccess, reversePointsOnRefund } from "../../api/lib/points.service.js";
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

export async function processTopup(trxId) {
  // Ambil transaksi + tipe produk
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: { select: { type: true, code: true } } }
  });
  if (!trx) throw new Error('Transaksi tidak ditemukan');
  if (trx.product?.type !== 'PULSA') throw new Error('Transaksi bukan PULSA');

  // Hanya proses yang eligible
  if (!['WAITING', 'PENDING', 'PROCESSING'].includes(trx.status)) {
    return { skip: `not-eligible(${trx.status})` };
  }

  // Kandidat supplier
  const candidates = await pickCandidatesForWorker(trx.productId);
  if (!candidates.length) {
    await finalizeFailed(trxId, { message: 'NO_SUPPLIER', supplierResult: { error: 'no supplier' } });
    await pushTrxUpdate(trxId, { status: 'FAILED', message: 'NO_SUPPLIER' });
    return;
  }

  // Tandai PENDING saat mulai dispatch pertama kali
  if (trx.status === 'WAITING') {
    try {
      await prisma.transaction.update({
        where: { id: trxId },
        data: { status: 'PENDING', message: 'PENDING (dispatch to supplier)' }
      });
      await pushTrxUpdate(trxId, { status: 'PENDING', message: 'PENDING (dispatch to supplier)' });
      trx.status = 'PENDING';
    } catch { /* noop */ }
  }

  let lastErr = null;

  for (const c of candidates) {
    try {
      // supplierId dari mapping kandidat
      const supId = c?.sp?.supplierId || c?.ep?.supplierId || null;
      if (!supId) {
        lastErr = 'SUPPLIER_ID_MISSING';
        console.warn('[processTopup] supplierId missing', { trxId, candidate: { spSupplierId: c?.sp?.supplierId, epSupplierId: c?.ep?.supplierId } });
        continue;
      }

      // SKU per supplier
      const mapping = await prisma.supplierProduct.findUnique({
        where: { supplierId_productId: { supplierId: supId, productId: trx.productId } },
        select: { supplierSku: true, isAvailable: true }
      });

      const supplierSku = mapping?.supplierSku || trx.product?.code || null;
      if (!mapping || mapping.isAvailable === false || !supplierSku) {
        lastErr = `SUPPLIER_SKU_NOT_FOUND (productId=${trx.productId}, supplierId=${supId})`;
        console.warn('[processTopup] skip: missing/unavailable supplierSku', {
          trxId, productId: trx.productId, supplierId: supId, mappingFound: !!mapping
        });
        continue;
      }

      // Supplier.code untuk config
      let supplierCode = c?.supplierCode;
      if (!supplierCode) {
        const sup = await prisma.supplier.findUnique({ where: { id: supId }, select: { code: true } });
        supplierCode = sup?.code || null;
      }
      if (!supplierCode) {
        lastErr = `SUPPLIER_CODE_NOT_FOUND (supplierId=${supId})`;
        console.warn('[processTopup] skip: missing supplierCode', { supplierId: supId });
        continue;
      }

      // Jejak supplierSku di payload
      await prisma.transaction.update({
        where: { id: trxId },
        data: {
          status: "PROCESSING",
          supplierId: supId,
          supplierPayload: {
            ...(trx.supplierPayload || {}),
            supplierSku
          }
        }
      });

      // Panggil supplier (SKU pakai field 'product', bukan 'sku')
      const ctx = {
        baseUrl: c.ep.baseUrl,
        apiKey: c.ep.apiKey || undefined,
        secret: c.ep.secret || undefined,
        ref: trx.invoiceId || trx.id,
        product: supplierSku,
        msisdn: trx.msisdn
      };

      const res = await callSupplier('topup', supplierCode, ctx);
      if (!res.ok) { lastErr = res.error || 'transport'; continue; }
// console.log(res, ctx )
      // Deteksi serial/token (baik dari norm.extra.serial maupun raw)
      const serialFromNorm = res.norm?.extra?.serial;
      const serialFromRaw  = deepFindByKeys(res.data, SERIAL_KEYS);
      const serial = (serialFromNorm || serialFromRaw) ? String(serialFromNorm || serialFromRaw).slice(0, 512) : undefined;

      // Simpan supplierRef, raw, dan serial jika ada
      await prisma.transaction.update({
        where: { id: trxId },
        data: {
          supplierRef: res.norm?.supplierRef ?? trx.supplierRef ?? null,
          supplierResult: res.data,
          ...(serial ? { serial } : {})
        }
      });

      const st = String(res.norm?.status || '').toUpperCase();
      const msg = res.norm?.message || st || 'PROCESSING';

      if (st === 'SUCCESS') {
        await awardPointsForSuccess(trxId);
        await finalizeSuccess(trxId, { message: res.norm?.message || 'SUCCESS', supplierResult: res.data });
        await pushTrxUpdate(trxId, { status: 'SUCCESS', message: res.norm?.message || 'SUCCESS', ...(serial ? { serial } : {}) });
        return;
      }
      if (['FAILED', 'CANCELED', 'EXPIRED'].includes(st)) {
        await finalizeFailed(trxId, { message: res.norm?.message || st, supplierResult: res.data });
        await pushTrxUpdate(trxId, { status: st, message: res.norm?.message || st });
        return;
      }

      // Menunggu callback/polling
      await prisma.transaction.update({
        where: { id: trxId },
        data: { status: 'PROCESSING', message: msg }
      });
      await pushTrxUpdate(trxId, { status: 'PROCESSING', message: msg, ...(serial ? { serial } : {}) });
      return;

    } catch (e) {
      lastErr = e?.message || String(e);
      console.error('[processTopup] candidate failed', { trxId, err: lastErr });
    }
  }

  await finalizeFailed(trxId, { message: lastErr || 'ALL_SUPPLIER_FAILED', supplierResult: { error: lastErr } });
  await pushTrxUpdate(trxId, { status: 'FAILED', message: lastErr || 'ALL_SUPPLIER_FAILED' });
}
