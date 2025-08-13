// worker/ops/processInquiryBill.js
import prisma from '../../api/prisma.js';
import { pickCandidatesForWorker } from '../../utils/supplierPicker.js';
import { callSupplier } from '../../api/lib/supplier-client.js';
import { computeEffectiveSellPrice } from '../../api/lib/effective-price.js';
import { pushTrxUpdate } from '../utils/socket.js'; // opsional, aman jika tidak di-setup

export async function processInquiryBill(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: true }
  });
  if (!trx) throw new Error('Transaksi tidak ditemukan');
  if (trx.product?.type !== 'TAGIHAN') throw new Error('Transaksi bukan TAGIHAN');
  // Boleh dipanggil saat status: PENDING/PROCESSING/QUOTED (untuk refresh inquiry)
  if (trx.status === 'SUCCESS' || trx.status === 'FAILED' || trx.status === 'CANCELED' || trx.status === 'EXPIRED') {
    return { skip: 'already-final' };
  }

  const candidates = await pickCandidatesForWorker(trx.productId);
  if (!candidates.length) {
    await prisma.transaction.update({ where: { id: trxId }, data: { status: 'FAILED', message: 'NO_SUPPLIER' } });
    pushTrxUpdate(trxId, { status: 'FAILED', message: 'NO_SUPPLIER' });
    return;
  }

  let lastErr = null;

  for (const c of candidates) {
    try {
      const ctx = {
        baseUrl: c.ep.baseUrl,
        apiKey: c.ep.apiKey,
        ref: trx.invoiceId,
        sku: trx.supplierPayload?.supplierSku || null,
        customerNo: trx.msisdn
      };

      const res = await callSupplier('inquiry', c.supplierCode, ctx);
      if (!res.ok) { lastErr = res.error || 'transport'; continue; }

      const st = res.norm.status; // SUCCESS/FAILED/PENDING
      // simpan hasil mentah & ref
      const writeBase = {
        supplierId: c.sp.supplierId,
        supplierRef: res.norm.supplierRef ?? trx.supplierRef,
        supplierPayload: {
          ...(trx.supplierPayload || {}),
          step: 'INQUIRY',
          endpointId: c.ep.id,
          baseUrl: c.ep.baseUrl,
          supplierSku: c.sp.supplierSku,
          supplierFee: res.norm.adminFee ?? (trx.supplierPayload?.supplierFee ?? 0n),
        },
        supplierResult: res.data
      };

      if (st === 'FAILED') {
        await prisma.transaction.update({
          where: { id: trxId },
          data: { ...writeBase, status: 'FAILED', message: res.norm.message || 'FAILED' }
        });
        pushTrxUpdate(trxId, { status: 'FAILED', message: res.norm.message || 'FAILED' });
        return;
      }

      if (st === 'PENDING') {
        await prisma.transaction.update({
          where: { id: trxId },
          data: { ...writeBase, status: 'PROCESSING', message: res.norm.message || 'PROCESSING' }
        });
        pushTrxUpdate(trxId, { status: 'PROCESSING', message: res.norm.message || 'PROCESSING' });
        return;
      }

      // SUCCESS: normalisasi harga
      const amountDue = res.norm.amount ?? 0n;
      const baseAdminFee = BigInt(trx.product?.margin || 0n);

      // Hitung markup berantai (effective - baseDefault)
      const baseDefault = BigInt(trx.product.basePrice || 0n) + BigInt(trx.product.margin || 0n);
      const { effectiveSell } = await computeEffectiveSellPrice(trx.resellerId, trx.productId);
      let markupSum = BigInt(effectiveSell) - baseDefault;
      if (markupSum < 0n) markupSum = 0n;

      const sellPrice = amountDue + baseAdminFee + markupSum;
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      await prisma.transaction.update({
        where: { id: trxId },
        data: {
          ...writeBase,
          type: 'TAGIHAN_INQUIRY',
          amountDue,
          adminFee: baseAdminFee,
          markupSum,
          sellPrice,
          status: 'QUOTED',
          message: res.norm.message || 'OK',
          expiresAt
        }
      });

      pushTrxUpdate(trxId, {
        status: 'QUOTED',
        amountDue: Number(amountDue),
        adminFee: Number(baseAdminFee),
        markupSum: Number(markupSum),
        sellPrice: Number(sellPrice),
        expiresAt
      });
      return;
    } catch (e) {
      lastErr = e?.message || String(e);
      // lanjut ke kandidat berikutnya
    }
  }

  await prisma.transaction.update({
    where: { id: trxId },
    data: { status: 'FAILED', message: lastErr || 'ALL_SUPPLIER_FAILED' }
  });
  pushTrxUpdate(trxId, { status: 'FAILED', message: lastErr || 'ALL_SUPPLIER_FAILED' });
}
