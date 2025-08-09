// worker/worker.js
import 'dotenv/config';
import axios from 'axios';
import pkg from 'bullmq';
import prisma from '../api/prisma.js';
import { connection, QUEUE_NAME, trxQueue } from '../queues.js';

const { Worker } = pkg;

const QNAME = QUEUE_NAME || 'trxQueue';

console.log('🚀 Worker transaksi start …');

const worker = new Worker(
  QNAME,
  async (job) => {
    const { name, data } = job;

    if (name === 'dispatch') return handleDispatchTopup(data.trxId);
    if (name === 'dispatch_paybill') return handleDispatchPaybill(data.trxId);
    if (name === 'poll_inquiry') return handlePollInquiry(data.trxId);

    console.warn(`⚠️  Unknown job: ${name}`);
  },
  { connection }
);

// ---- event logs
worker.on('completed', (job) => console.log(`🎯 ${job.name}(${job.id}) done`));
worker.on('failed', (job, err) => console.error(`💥 ${job?.name}(${job?.id}) failed:`, err?.message));

// -------- utils
const toNum = (v) => (v == null ? null : Number(v));

/**
 * Ambil supplier-product yang available + endpoint aktif dengan prioritas/cost terendah.
 */
async function pickSupplierWithEndpoint(productId) {
  const list = await prisma.supplierProduct.findMany({
    where: { productId, isAvailable: true, supplier: { status: 'ACTIVE' } },
    include: { supplier: { include: { endpoints: true } } },
    orderBy: [{ priority: 'asc' }, { costPrice: 'asc' }],
  });
  for (const sp of list) {
    const ep = sp.supplier.endpoints.find((e) => e.isActive);
    if (ep) return { sp, ep };
  }
  return null;
}

/**
 * Helper: pastikan saldo record ada; kalau tidak ada, buat 0.
 */
async function ensureSaldo(tx, resellerId) {
  const cur = await tx.saldo.findUnique({ where: { resellerId }, select: { resellerId: true } });
  if (cur) return cur;
  return tx.saldo.create({ data: { resellerId, amount: 0n } });
}

/**
 * Helper: CREDIT (tambah saldo) atomic dengan before/after.
 * amount harus BigInt positif.
 */
async function createMutasiCredit(
  tx,
  { trxId, resellerId, amount, type = 'CREDIT', source, note, reference }
) {
  await ensureSaldo(tx, resellerId);
  const updated = await tx.saldo.update({
    where: { resellerId },
    data: { amount: { increment: BigInt(amount) } },
    select: { amount: true },
  });
  const afterAmount = updated.amount;
  const beforeAmount = afterAmount - BigInt(amount);

  return tx.mutasiSaldo.create({
    data: {
      trxId,
      resellerId,
      type, // enum, mis: 'REFUND' | 'CREDIT'
      source, // mis: 'REFUND_TRX'
      amount: BigInt(amount),
      beforeAmount,
      afterAmount,
      note: note ?? null,
      reference: reference ?? null,
      // status: SUCCESS (default di schema)
    },
  });
}

/**
 * Helper: DEBIT (kurangi saldo) atomic dengan before/after.
 * amount harus BigInt positif.
 * Jika perlu validasi saldo cukup, tambahkan cekBalance=true.
 */
async function createMutasiDebit(
  tx,
  { trxId, resellerId, amount, type = 'DEBIT', source, note, reference, cekBalance = false }
) {
  await ensureSaldo(tx, resellerId);

  if (cekBalance) {
    const cur = await tx.saldo.findUnique({ where: { resellerId }, select: { amount: true } });
    if ((cur?.amount ?? 0n) < BigInt(amount)) {
      throw new Error('Saldo tidak cukup untuk debit.');
    }
  }

  const updated = await tx.saldo.update({
    where: { resellerId },
    data: { amount: { decrement: BigInt(amount) } },
    select: { amount: true },
  });
  const afterAmount = updated.amount;
  const beforeAmount = afterAmount + BigInt(amount);

  return tx.mutasiSaldo.create({
    data: {
      trxId,
      resellerId,
      type, // 'DEBIT'
      source, // mis: 'ORDER_DEBIT'
      amount: BigInt(amount),
      beforeAmount,
      afterAmount,
      note: note ?? null,
      reference: reference ?? null,
    },
  });
}

/**
 * Settlement terminal transaksi:
 * - FAILED/CANCELED/EXPIRED => REFUND (CREDIT) kalau belum pernah
 * - SUCCESS => (opsional) payout komisi
 */
async function settlement(trxId) {
  const trx = await prisma.transaction.findUnique({ where: { id: trxId } });
  if (!trx) return;

  const terminal = ['SUCCESS', 'FAILED', 'REFUNDED', 'CANCELED', 'EXPIRED'];
  if (!terminal.includes(trx.status)) return;

  if (['FAILED', 'CANCELED', 'EXPIRED'].includes(trx.status)) {
    const need = BigInt(trx.sellPrice ?? 0n) + BigInt(trx.adminFee ?? 0n);

    // Jika kamu pakai @@unique([trxId, type]) maka satu REFUND per trx.
    const refunded = await prisma.mutasiSaldo.findFirst({
      where: { trxId: trx.id, type: 'REFUND' },
      select: { id: true },
    });

    if (!refunded && need > 0n) {
      await prisma.$transaction(async (tx) => {
        await createMutasiCredit(tx, {
          trxId: trx.id,
          resellerId: trx.resellerId,
          amount: need,
          type: 'REFUND',
          source: 'REFUND_TRX',
          note: `Refund ${trx.invoiceId}`,
          reference: trx.supplierRef || trx.invoiceId,
        });
      });
      console.log(`↩️  Refund selesai (${trx.invoiceId})`);
    }
  }

  // TODO: payout komisi saat SUCCESS (jika sudah ada rule komisi)
}

// -------- handlers
async function handleDispatchTopup(trxId) {
  const trx = await prisma.transaction.findUnique({ where: { id: trxId }, include: { product: true } });
  if (!trx) throw new Error(`Transaksi ${trxId} tidak ditemukan.`);
  if (!['PENDING', 'PROCESSING'].includes(trx.status)) return;

  const picked = await pickSupplierWithEndpoint(trx.productId);
  if (!picked) {
    await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: 'FAILED', supplierResult: { error: 'No available supplier/endpoint' } },
    });
    await settlement(trx.id);
    return;
  }
  const { sp, ep } = picked;
  const url = `${ep.baseUrl.replace(/\/+$/, '')}/order`;
  const headers = ep.apiKey ? { 'x-api-key': ep.apiKey } : {};
  const body = { ref: trx.invoiceId, sku: sp.supplierSku, msisdn: trx.msisdn, amount: toNum(trx.sellPrice) };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 15000 });
    const st = String(data?.status || '').toUpperCase();
    const normalized = ['SUCCESS', 'FAILED', 'PROCESSING'].includes(st) ? st : 'PROCESSING';

    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: {
        status: normalized,
        supplierId: sp.supplierId,
        supplierRef: data?.supplierRef ?? data?.ref ?? trx.supplierRef ?? trx.invoiceId,
        supplierPayload: { endpoint: url, request: body },
        supplierResult: data,
      },
    });

    if (updated.status === 'PROCESSING') {
      await trxQueue.add('poll_inquiry', { trxId: updated.id }, { delay: 10_000, removeOnComplete: true, removeOnFail: true });
    } else {
      await settlement(updated.id);
    }
  } catch (err) {
    await prisma.transaction.update({
      where: { id: trx.id },
      data: {
        status: 'FAILED',
        supplierId: sp.supplierId,
        supplierPayload: { endpoint: url, request: body },
        supplierResult: { error: String(err?.message || err) },
      },
    });
    await settlement(trx.id);
  }
}

async function handlePollInquiry(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: {
      product: true,
      supplier: { include: { endpoints: true } },
    },
  });
  if (!trx) throw new Error(`Transaksi ${trxId} tidak ditemukan.`);

  let ep = trx.supplier?.endpoints?.find((e) => e.isActive);
  if (!ep) {
    const picked = await pickSupplierWithEndpoint(trx.productId);
    ep = picked?.ep;
  }
  if (!ep) {
    await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: 'FAILED', supplierResult: { error: 'No endpoint for polling' } },
    });
    await settlement(trx.id);
    return;
  }

  const url = `${ep.baseUrl.replace(/\/+$/, '')}/status`;
  const headers = ep.apiKey ? { 'x-api-key': ep.apiKey } : {};
  const body = { ref: trx.supplierRef || trx.invoiceId, invoiceId: trx.invoiceId };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 12000 });
    const st = String(data?.status || '').toUpperCase();
    const normalized = st === 'SUCCESS' ? 'SUCCESS' : st === 'FAILED' ? 'FAILED' : 'PROCESSING';

    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: normalized, supplierResult: data, updatedAt: new Date() },
    });

    if (updated.status === 'PROCESSING') {
      if (updated.expiresAt && updated.expiresAt.getTime() < Date.now()) {
        await prisma.transaction.update({
          where: { id: updated.id },
          data: { status: 'FAILED', supplierResult: { note: 'Expired TTL' } },
        });
        await settlement(updated.id);
      } else {
        await trxQueue.add('poll_inquiry', { trxId: updated.id }, { delay: 15_000, removeOnComplete: true, removeOnFail: true, attempts: 1 });
      }
    } else {
      await settlement(updated.id);
    }
  } catch (err) {
    console.error('poll_inquiry error:', err?.message || err);
    await trxQueue.add('poll_inquiry', { trxId }, { delay: 20_000, removeOnComplete: true, removeOnFail: true, attempts: 1 });
  }
}

async function handleDispatchPaybill(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: true, supplier: { include: { endpoints: true } } },
  });
  if (!trx) throw new Error(`Transaksi paybill ${trxId} tidak ditemukan.`);

  let ep = trx.supplier?.endpoints?.find((e) => e.isActive);
  if (!ep) {
    const picked = await pickSupplierWithEndpoint(trx.productId);
    ep = picked?.ep;
  }
  if (!ep) {
    await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: 'FAILED', supplierResult: { error: 'No endpoint for pay' } },
    });
    await settlement(trx.id);
    return;
  }

  const url = `${ep.baseUrl.replace(/\/+$/, '')}/pay`;
  const headers = ep.apiKey ? { 'x-api-key': ep.apiKey } : {};
  const body = { ref: trx.invoiceId, supplierRef: trx.supplierRef, customerNo: trx.msisdn, amount: toNum(trx.sellPrice) };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 15000 });
    const st = String(data?.status || '').toUpperCase();
    const normalized = st === 'SUCCESS' ? 'SUCCESS' : st === 'FAILED' ? 'FAILED' : 'PROCESSING';

    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: normalized, supplierResult: data, supplierPayload: { endpoint: url, request: body } },
    });

    if (updated.status === 'PROCESSING') {
      await trxQueue.add('poll_inquiry', { trxId: updated.id }, { delay: 10_000, removeOnComplete: true, removeOnFail: true });
    } else {
      await settlement(updated.id);
    }
  } catch (err) {
    await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: 'FAILED', supplierResult: { error: String(err?.message || err) }, supplierPayload: { endpoint: url, request: body } },
    });
    await settlement(trx.id);
  }
}

// -------- graceful shutdown
process.on('SIGINT', async () => {
  console.log('SIGINT received. Closing worker…');
  await worker.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing worker…');
  await worker.close();
  process.exit(0);
});
