// worker/ops/processPayBill.js
import prisma from '../../api/prisma.js';
import { pickCandidatesForWorker } from '../../utils/supplierPicker.js';
import { callSupplier } from '../../api/lib/supplier-client.js';
import { finalizeSuccess, finalizeFailed } from '../../api/lib/finalize.js';
import { pushTrxUpdate } from '../utils/socket.js';

export async function processPayBill(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: true }
  });
  if (!trx) throw new Error('Transaksi tidak ditemukan');
  if (trx.product?.type !== 'TAGIHAN') throw new Error('Transaksi bukan TAGIHAN');
  if (trx.status !== 'PENDING' && trx.status !== 'PROCESSING') return { skip: 'not-pending' };

  const candidates = await pickCandidatesForWorker(trx.productId);
  if (!candidates.length) {
    await finalizeFailed(trxId, { message: 'NO_SUPPLIER', supplierResult: { error: 'no supplier' } });
    pushTrxUpdate(trxId, { status: 'FAILED', message: 'NO_SUPPLIER' });
    return;
  }

  let lastErr = null;

  for (const c of candidates) {
    try {
      const amountToVendor = (trx.supplierPayload?.amountDue ?? trx.amountDue ?? 0n)
                           + (trx.supplierPayload?.supplierFee ?? 0n);

      const ctx = {
        baseUrl: c.ep.baseUrl,
        apiKey: c.ep.apiKey,
        ref: trx.invoiceId,
        sku: trx.supplierPayload?.supplierSku || null,
        customerNo: trx.msisdn,
        amount: amountToVendor
      };

      const res = await callSupplier('paybill', c.supplierCode, ctx);
      if (!res.ok) { lastErr = res.error || 'transport'; continue; }

      // Simpan raw dulu
      await prisma.transaction.update({
        where: { id: trxId },
        data: { supplierRef: res.norm.supplierRef ?? trx.supplierRef, supplierResult: res.data }
      });

      const st = res.norm.status;
      if (st === 'SUCCESS') {
        await finalizeSuccess(trxId, { message: res.norm.message || 'SUCCESS', supplierResult: res.data });
        pushTrxUpdate(trxId, { status: 'SUCCESS', message: res.norm.message || 'SUCCESS' });
        return;
      }
      if (st === 'FAILED') {
        await finalizeFailed(trxId, { message: res.norm.message || 'FAILED', supplierResult: res.data });
        pushTrxUpdate(trxId, { status: 'FAILED', message: res.norm.message || 'FAILED' });
        return;
      }

      // PENDING → biarkan callback/polling menyelesaikan
      await prisma.transaction.update({
        where: { id: trxId },
        data: { status: 'PROCESSING', message: res.norm.message || 'PROCESSING' }
      });
      pushTrxUpdate(trxId, { status: 'PROCESSING', message: res.norm.message || 'PROCESSING' });
      return;
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }

  await finalizeFailed(trxId, { message: lastErr || 'ALL_SUPPLIER_FAILED', supplierResult: { error: lastErr } });
  pushTrxUpdate(trxId, { status: 'FAILED', message: lastErr || 'ALL_SUPPLIER_FAILED' });
}
