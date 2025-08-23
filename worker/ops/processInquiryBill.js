// worker/ops/processInquiryBill.js
import prisma from '../../api/prisma.js';
import { pickCandidatesForWorker } from '../../utils/supplierPicker.js';
import { callSupplier } from '../../api/lib/supplier-client.js';
import { computeEffectiveSellPrice } from '../../api/lib/effective-price.js';
import { pushTrxUpdate } from '../utils/socket.js'; // opsional, aman jika tidak di-setup

const onlyDigits = (v) => (v == null ? undefined : String(v).replace(/[^\d]/g, '') || undefined);

export async function processInquiryBill(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: true }
  });
  if (!trx) throw new Error('Transaksi tidak ditemukan');
  if (trx.product?.type !== 'TAGIHAN') throw new Error('Transaksi bukan TAGIHAN');

  // Boleh dipanggil saat status: WAITING / PENDING / PROCESSING (refresh inquiry)
  if (!['WAITING', 'PENDING', 'PROCESSING'].includes(trx.status)) {
    return { skip: `not-eligible(${trx.status})` };
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
      // Ambil snapshot request (idNumber/dest/amount) dari payload inquiry sebelumnya
      const reqSnap = trx.supplierPayload?.request || {};
      const idNumber = reqSnap.idNumber ?? trx.msisdn; // fallback aman
      const dest     = reqSnap.dest ?? trx.msisdn;     // tujuan tersimpan di msisdn
      const amount   = onlyDigits(reqSnap.amount);     // open denom (opsional)

      // Siapkan konteks pemanggilan vendor
      const ctx = {
        baseUrl: c.ep.baseUrl,
        apiKey: c.ep.apiKey || undefined,
        secret: c.ep.secret || undefined,
        ref: trx.invoiceId,
        product: c.sp?.supplierSku || trx.supplierPayload?.supplierSku || null,
        customerNo: String(idNumber || ''), // Nomor ID pelanggan
        msisdn: String(dest || ''),        // Nomor tujuan (bila dipakai vendor)
        ...(amount ? { amount } : {}),
      };

      const res = await callSupplier('inquiry', c.supplierCode, ctx);
      if (!res.ok) { lastErr = res.error || 'transport'; continue; }

      const norm = res.norm || {};
      const st = String(norm.status || '').toUpperCase();

      // Tulang punggung data yang selalu disimpan
      const writeBase = {
        supplierId: c.sp.supplierId,
        supplierRef: norm.supplierRef ?? trx.supplierRef ?? null,
        supplierPayload: {
          ...(trx.supplierPayload || {}),
          step: 'INQUIRY',
          endpointId: c.ep.id,
          baseUrl: c.ep.baseUrl,
          supplierSku: c.sp.supplierSku,
          supplierFee: norm.adminFee ?? (trx.supplierPayload?.supplierFee ?? 0n),
          request: {
            ...(reqSnap || {}),
            idNumber: String(idNumber || ''),
            dest: String(dest || ''),
            ...(amount ? { amount } : {}),
          }
        },
        supplierResult: res.data
      };

      if (st === 'FAILED' || st === 'CANCELED' || st === 'EXPIRED') {
        await prisma.transaction.update({
          where: { id: trxId },
          data: { ...writeBase, status: st, message: norm.message || st }
        });
        pushTrxUpdate(trxId, { status: st, message: norm.message || st });
        return;
      }

      if (st === 'PENDING' || st === 'PROCESSING') {
        await prisma.transaction.update({
          where: { id: trxId },
          data: { ...writeBase, status: 'PROCESSING', message: norm.message || 'PROCESSING' }
        });
        pushTrxUpdate(trxId, { status: 'PROCESSING', message: norm.message || 'PROCESSING' });
        return;
      }

      // SUCCESS → normalisasi harga dan jadikan WAITING (siap dibayar)
      const amountDue   = norm.amount ?? 0n; // BigInt
      const baseAdminFee = BigInt(trx.product?.margin || 0n);

      // Hitung markup berantai (effective - baseDefault)
      const baseDefault = BigInt(trx.product?.basePrice || 0n) + BigInt(trx.product?.margin || 0n);
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
          status: 'WAITING', // ← belum diproses/dibayar
          message: norm.message || 'OK',
          expiresAt
        }
      });

      pushTrxUpdate(trxId, {
        status: 'WAITING',
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
