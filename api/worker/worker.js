// worker/worker.js
import 'dotenv/config';
import axios from 'axios';
import pkg from 'bullmq';
import prisma from '../api/prisma.js';
import { connection, QUEUE_NAME, trxQueue } from '../../queues.js';
import { randomUUID } from "crypto"; // ⬅️ di atas file
const { Worker } = pkg;

console.log('🚀 Worker transaksi start …');

// ========== Worker ==========
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { name, data } = job;

    if (name === 'dispatch') {
      return await handleDispatchTopup(data.trxId);
    }
    if (name === 'dispatch_paybill') {
      return await handleDispatchPaybill(data.trxId);
    }
    if (name === 'poll_inquiry') {
      return await handlePollInquiry(data.trxId);
    }

    console.warn(`⚠️  Unknown job: ${name}`);
  },
  { connection }
);

worker.on('completed', (job) => console.log(`🎯 ${job.name}(${job.id}) done`));
worker.on('failed', (job, err) => console.error(`💥 ${job?.name}(${job?.id}) failed:`, err?.message));

// ========== Util ==========
const toNum = (v) => (v == null ? null : Number(v));
const nowPlus = (ms) => new Date(Date.now() + ms);

async function pickSupplierWithEndpoint(productId) {
  const list = await prisma.supplierProduct.findMany({
    where: {
      productId,
      isAvailable: true,
      supplier: { status: 'ACTIVE' },
    },
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
    if (need <= 0n) return;

    await prisma.$transaction(async (tx) => {
      // 🔒 Kunci baris saldo via update dummy agar aman dari race
      const cur = await tx.saldo.update({
        where: { resellerId: trx.resellerId },
        data: {}, // no-op update, tapi mengunci row
        select: { amount: true },
      }).catch(async (e) => {
        // jika belum ada saldo, buat dulu lalu ambil (tetap mengunci)
        await tx.saldo.create({ data: { resellerId: trx.resellerId, amount: 0n } });
        return tx.saldo.update({
          where: { resellerId: trx.resellerId },
          data: {},
          select: { amount: true },
        });
      });

      // ❗ Cek REFUND per trx+type (butuh @@unique([trxId,type]))
      const exist = await tx.mutasiSaldo.findUnique({
        where: { MutasiSaldo_trxId_type_key: { trxId: trx.id, type: 'REFUND' } },
        select: { id: true },
      });
      if (exist) return; // sudah pernah refund, selesai

      // Baru lakukan credit sekali saja
      const updated = await tx.saldo.update({
        where: { resellerId: trx.resellerId },
        data: { amount: { increment: need } },
        select: { amount: true },
      });
      const afterAmount = updated.amount;
      const beforeAmount = afterAmount - need;

      await tx.mutasiSaldo.create({
        data: {
          trxId: trx.id,
          resellerId: trx.resellerId,
          type: 'REFUND',
          source: 'REFUND_TRX',
          amount: need,
          beforeAmount,
          afterAmount,
          note: `Refund ${trx.invoiceId}`,
          reference: trx.supplierRef || trx.invoiceId,
        },
      });
    }).catch((e) => {
      // Jika masih dapat unique di sini, biarkan lewat (idempoten)
      if (!/Unique constraint failed|duplicate key value/i.test(String(e.message))) {
        throw e;
      }
    });

    console.log(`↩️  Refund selesai (${trx.invoiceId})`);
  }
}



// ========== Handlers ==========

// --- Topup order ke supplier
async function handleDispatchTopup(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: true },
  });
  if (!trx) throw new Error(`Transaksi ${trxId} tidak ditemukan.`);
  if (!['PENDING', 'PROCESSING'].includes(trx.status)) return;

  // pilih supplier + endpoint
  const picked = await pickSupplierWithEndpoint(trx.productId);
  if (!picked) {
    await prisma.transaction.update({
      where: { id: trx.id },
      data: {
        status: 'FAILED',
        supplierResult: { error: 'No available supplier/endpoint' },
      },
    });
    await settlement(trx.id);
    return;
  }
  const { sp, ep } = picked;

  const url = `${ep.baseUrl.replace(/\/+$/, '')}/order`;
  const headers = ep.apiKey ? { 'x-api-key': ep.apiKey } : {};
  const body = {
    ref: trx.invoiceId,
    sku: sp.supplierSku,
    msisdn: trx.msisdn,
    amount: toNum(trx.sellPrice), // biasanya pulsa tidak kirim amount; sesuaikan jika perlu
  };

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
      await trxQueue.add(
        'poll_inquiry',
        { trxId: updated.id },
        { delay: 10_000, removeOnComplete: true, removeOnFail: true }
      );
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

// --- Poll status transaksi (topup / bill)
async function handlePollInquiry(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: {
      product: true,
      // ambil supplier + endpoint aktif sesuai supplierId di trx
      // (kalau kosong, fallback pickSupplierWithEndpoint)
      // @ts-ignore
      supplier: { include: { endpoints: true } },
    },
  });
  if (!trx) throw new Error(`Transaksi ${trxId} tidak ditemukan.`);

  let ep;
  if (trx.supplierId) {
    const sup = await prisma.supplier.findUnique({
      where: { id: trx.supplierId },
      include: { endpoints: true },
    });
    ep = sup?.endpoints?.find((e) => e.isActive);
  }
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
  const body = {
    ref: trx.supplierRef || trx.invoiceId,
    invoiceId: trx.invoiceId,
  };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 12000 });
    const st = String(data?.status || '').toUpperCase();
    const normalized =
      st === 'SUCCESS' ? 'SUCCESS' :
      st === 'FAILED'  ? 'FAILED'  :
      'PROCESSING';

    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: {
        status: normalized,
        supplierResult: data,
        updatedAt: new Date(),
      },
    });

    if (updated.status === 'PROCESSING') {
      // batasi TTL polling via expiresAt
      if (updated.expiresAt && updated.expiresAt.getTime() < Date.now()) {
        await prisma.transaction.update({
          where: { id: updated.id },
          data: { status: 'FAILED', supplierResult: { ...data, note: 'Expired TTL' } },
        });
        await settlement(updated.id);
      } else {
        await trxQueue.add(
          'poll_inquiry',
          { trxId: updated.id },
          { delay: 15_000, removeOnComplete: true, removeOnFail: true, attempts: 1 }
        );
      }
    } else {
      await settlement(updated.id);
    }
  } catch (err) {
    console.error('poll_inquiry error:', err?.message || err);
    // retry ringan
    await trxQueue.add(
      'poll_inquiry',
      { trxId },
      { delay: 20_000, removeOnComplete: true, removeOnFail: true, attempts: 1 }
    );
  }
}

// --- Pay bill (setelah inquiry & hold saldo di controller)
async function handleDispatchPaybill(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: {
      product: true,
      // @ts-ignore
      supplier: { include: { endpoints: true } },
    },
  });
  if (!trx) throw new Error(`Transaksi paybill ${trxId} tidak ditemukan.`);

  let ep;
  if (trx.supplierId) {
    const sup = await prisma.supplier.findUnique({
      where: { id: trx.supplierId },
      include: { endpoints: true },
    });
    ep = sup?.endpoints?.find((e) => e.isActive);
  }
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
  const body = {
    ref: trx.invoiceId,
    supplierRef: trx.supplierRef,
    customerNo: trx.msisdn,
    amount: toNum(trx.sellPrice),
  };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 15000 });
    const st = String(data?.status || '').toUpperCase();
    const normalized =
      st === 'SUCCESS' ? 'SUCCESS' :
      st === 'FAILED'  ? 'FAILED'  :
      'PROCESSING';

    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: {
        status: normalized,
        supplierResult: data,
        supplierPayload: { endpoint: url, request: body },
      },
    });

    if (updated.status === 'PROCESSING') {
      await trxQueue.add(
        'poll_inquiry',
        { trxId: updated.id },
        { delay: 10_000, removeOnComplete: true, removeOnFail: true }
      );
    } else {
      await settlement(updated.id);
    }
  } catch (err) {
    await prisma.transaction.update({
      where: { id: trx.id },
      data: {
        status: 'FAILED',
        supplierResult: { error: String(err) },
        supplierPayload: { endpoint: url, request: body },
      },
    });
    await settlement(trx.id);
  }
}

// ========== Graceful shutdown ==========
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
