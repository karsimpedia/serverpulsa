// worker/worker.js
import 'dotenv/config';
import axios from 'axios';
import pkg from 'bullmq';
import prisma from '../api/prisma.js';
import { connection, QUEUE_NAME, trxQueue } from '../queues.js';

const { Worker } = pkg;

console.log('🚀 Worker transaksi start …');

const worker = new Worker(
  QUEUE_NAME, // pastikan sama dengan QUEUE_NAME di queues.js (default: 'trxQueue')
  async (job) => {
    const { name, data } = job;

    if (name === 'dispatch') return handleDispatchTopup(data.trxId);
    if (name === 'dispatch_paybill') return handleDispatchPaybill(data.trxId);
    if (name === 'poll_inquiry') return handlePollInquiry(data.trxId);

    console.warn(`⚠️  Unknown job: ${name}`);
  },
  { connection }
);

worker.on('completed', (job) => console.log(`🎯 ${job.name}(${job.id}) done`));
worker.on('failed', (job, err) => console.error(`💥 ${job?.name}(${job?.id}) failed:`, err?.message));

// -------- utils
const toNum = (v) => (v == null ? null : Number(v));

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

async function settlement(trxId) {
  const trx = await prisma.transaction.findUnique({ where: { id: trxId } });
  if (!trx) return;

  const terminal = ['SUCCESS', 'FAILED', 'REFUNDED', 'CANCELED', 'EXPIRED'];
  if (!terminal.includes(trx.status)) return;

  if (['FAILED', 'CANCELED', 'EXPIRED'].includes(trx.status)) {
    const need = BigInt(trx.sellPrice ?? 0n) + BigInt(trx.adminFee ?? 0n);
    const refunded = await prisma.mutasiSaldo.findFirst({ where: { trxId: trx.id, type: 'REFUND' } });
    if (!refunded && need > 0n) {
      await prisma.$transaction(async (tx) => {
        const saldo = await tx.saldo.findUnique({ where: { resellerId: trx.resellerId } });
        await tx.saldo.update({ where: { resellerId: trx.resellerId }, data: { amount: (saldo?.amount ?? 0n) + need } });
        await tx.mutasiSaldo.create({
          data: { resellerId: trx.resellerId, trxId: trx.id, amount: need, type: 'REFUND', note: `Refund ${trx.invoiceId}` },
        });
      });
      console.log(`↩️  Refund selesai (${trx.invoiceId})`);
    }
  }

  // TODO: payout komisi saat SUCCESS (kalau sudah ada rule)
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
        supplierRef: data?.supplierRef ?? data?.ref ?? trx.supplierRef,
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
        supplierResult: { error: String(err) },
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
      data: { status: 'FAILED', supplierResult: { error: String(err) }, supplierPayload: { endpoint: url, request: body } },
    });
    await settlement(trx.id);
  }
}

// -------- shutdown
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
