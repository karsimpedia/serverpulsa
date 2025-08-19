// worker/ops/processTopup.js
import prisma from '../../api/prisma.js';
import { pickCandidatesForWorker } from '../../utils/supplierPicker.js';
import { callSupplier } from '../../api/lib/supplier-client.js';
import { finalizeSuccess, finalizeFailed } from '../../api/lib/finalize.js';
import { pushTrxUpdate } from '../utils/socket.js';

export async function processTopup(trxId) {
  // Ambil transaksi + relasi product (type, code)
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: { select: { type: true, code: true } } }
  });
  if (!trx) throw new Error('Transaksi tidak ditemukan');
  if (trx.product?.type !== 'PULSA') throw new Error('Transaksi bukan PULSA');
  if (trx.status == 'FAILED' && trx.status == 'SUCCESS') {
    return { skip: 'not-pending' };
  }

  // Cari kandidat supplier untuk productId ini
  const candidates = await pickCandidatesForWorker(trx.productId);
  if (!candidates.length) {
    await finalizeFailed(trxId, { message: 'NO_SUPPLIER', supplierResult: { error: 'no supplier' } });
    await pushTrxUpdate(trxId, { status: 'FAILED', message: 'NO_SUPPLIER' });
    return;
  }

  let lastErr = null;

  for (const c of candidates) {
    try {
      // Pastikan supplierId ada (ambil dari kandidat atau endpoint)
      const supId = c?.supplierId ?? c?.ep?.supplierId;
      if (!supId) {
        lastErr = 'SUPPLIER_ID_MISSING';
        console.warn('[processTopup] supplierId missing', {
          trxId, candidate: { supplierId: c?.supplierId, epSupplierId: c?.ep?.supplierId }
        });
        continue;
      }

      // Ambil mapping SupplierProduct (SKU per supplier)
      const mapping = await prisma.supplierProduct.findUnique({
        where: { supplierId_productId: { supplierId: supId, productId: trx.productId } },
        select: { supplierSku: true, isAvailable: true }
      });

      // SKU yang dipakai ke supplier
      const supplierSku = mapping?.supplierSku || trx.product?.code || null;
      if (!mapping || mapping.isAvailable === false || !supplierSku) {
        lastErr = `SUPPLIER_SKU_NOT_FOUND (productId=${trx.productId}, supplierId=${supId})`;
        console.warn('[processTopup] skip: missing/unavailable supplierSku', {
          trxId, productId: trx.productId, supplierId: supId, mappingFound: !!mapping
        });
        continue;
      }

      // Ambil Supplier.code (dipakai sebagai supplierCode untuk config)
      let supplierCode = c?.supplierCode;
      if (!supplierCode) {
        const sup = await prisma.supplier.findUnique({
          where: { id: supId },
          select: { code: true }
        });
        supplierCode = sup?.code || null;
      }
      if (!supplierCode) {
        lastErr = `SUPPLIER_CODE_NOT_FOUND (supplierId=${supId})`;
        console.warn('[processTopup] skip: missing supplierCode', { supplierId: supId });
        continue;
      }

      // Simpan jejak supplier & payload 
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

      // Bangun context dan panggil supplier
      const ctx = {
        baseUrl: c.ep.baseUrl,
        apiKey: c.ep.apiKey,
        ref: trx.invoiceId || trx.id,
        sku: supplierSku,
        msisdn: trx.msisdn
      };

      // Kode supplier (Supplier.code) jadi arg ke-2, SKU di ctx.sku
      const res = await callSupplier('topup', supplierCode, ctx);
      if (!res.ok) { lastErr = res.error || 'transport'; continue; }

      // Simpan supplierRef & hasil mentah
      await prisma.transaction.update({
        where: { id: trxId },
        data: { supplierRef: res.norm.supplierRef ?? trx.supplierRef, supplierResult: res.data }
      });

      const st = res.norm.status;
      if (st === 'SUCCESS') {
        await finalizeSuccess(trxId, { message: res.norm.message || 'SUCCESS', supplierResult: res.data });
        await pushTrxUpdate(trxId, { status: 'SUCCESS', message: res.norm.message || 'SUCCESS' });
        return;
      }
      if (st === 'FAILED') {
        await finalizeFailed(trxId, { message: res.norm.message || 'FAILED', supplierResult: res.data });
        await pushTrxUpdate(trxId, { status: 'FAILED', message: res.norm.message || 'FAILED' });
        return;
      }

      // Jika masih proses (menunggu callback supplier)
      await prisma.transaction.update({
        where: { id: trxId },
        data: { status: 'PROCESSING', message: res.norm.message || 'PROCESSING' }
      });
      await pushTrxUpdate(trxId, { status: 'PROCESSING', message: res.norm.message || 'PROCESSING' });
      return;

    } catch (e) {
      lastErr = e?.message || String(e);
      console.error('[processTopup] candidate failed', { trxId, err: lastErr });
    }
  }

  await finalizeFailed(trxId, { message: lastErr || 'ALL_SUPPLIER_FAILED', supplierResult: { error: lastErr } });
  await pushTrxUpdate(trxId, { status: 'FAILED', message: lastErr || 'ALL_SUPPLIER_FAILED' });
}
