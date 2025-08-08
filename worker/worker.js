// worker/worker.js
import { Worker, QueueScheduler } from 'bullmq';
import axios from 'axios';
import prisma from '../api/prisma.js';
import { connection, trxQueue } from '../queue/queue.js';

/**
 * Queue scheduler untuk job delayed/retry.
 */
new QueueScheduler('trx', { connection });

/**
 * Ambil endpoint aktif pertama dari supplier yang memenuhi.
 */
async function pickSupplier(productId) {
  // Pilih supplierProduct yang available + supplier ACTIVE
  const list = await prisma.supplierProduct.findMany({
    where: {
      productId,
      isAvailable: true,
      supplier: { status: 'ACTIVE' }
    },
    include: {
      supplier: {
        include: { endpoints: true }
      }
    },
    orderBy: [{ priority: 'asc' }, { costPrice: 'asc' }]
  });

  // Ambil endpoint aktif pertama
  for (const sp of list) {
    const ep = sp.supplier.endpoints.find(e => e.isActive);
    if (ep) {
      return { sp, ep };
    }
  }
  return null;
}

/**
 * Kirim order ke supplier. Normalisasi respons.
 * Ubah sesuai spesifikasi supplier nyata.
 */
async function sendToSupplier(ep, sp, trx) {
  const url = `${ep.baseUrl.replace(/\/+$/, '')}/order`;

  const headers = {};
  if (ep.apiKey) headers['x-api-key'] = ep.apiKey;

  const body = {
    ref: trx.invoiceId,
    sku: sp.supplierSku,
    msisdn: trx.msisdn,
    amount: Number(sp.costPrice ?? 0n) // contoh payload
  };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 10000 });
    const statusRaw = String(data?.status ?? '').toUpperCase();
    const normalized =
      statusRaw === 'SUCCESS' ? 'SUCCESS' :
      statusRaw === 'FAILED' ? 'FAILED' : 'PROCESSING';

    return {
      status: normalized,                               // 'PROCESSING' | 'SUCCESS' | 'FAILED'
      supplierRef: data?.supplierRef ?? data?.ref ?? null,
      raw: data
    };
  } catch (err) {
    return { status: 'FAILED', supplierRef: null, raw: { error: String(err) } };
  }
}

/**
 * Kirim callback ke reseller jika punya ResellerCallback aktif.
 */
async function notifyReseller(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: {
      reseller: { include: { callbacks: true } },
      product: true
    }
  });
  if (!trx) return;

  const cb = trx.reseller.callbacks.find(c => c.isActive);
  if (!cb) return;

  const payload = {
    invoiceId: trx.invoiceId,
    status: trx.status,
    msisdn: trx.msisdn,
    productId: trx.productId,
    productCode: trx.product.code,
    sellPrice: Number(trx.sellPrice),
    adminFee: Number(trx.adminFee),
    updatedAt: trx.updatedAt
  };

  try {
    await axios.post(cb.url, payload, { timeout: 8000 });
  } catch {
    // abaikan error callback
  }

  await prisma.transaction.update({
    where: { id: trxId },
    data: { callbackSentAt: new Date() }
  });
}

/**
 * Dapatkan chain upline: [{ level:1, resellerId:U1 }, { level:2, resellerId:U2 }, ...]
 * Batasi maxDepth untuk keamanan.
 */
async function getUplineChain(resellerId, maxDepth = 10) {
  const chain = [];
  let currentId = resellerId;
  let level = 0;

  while (level < maxDepth) {
    const r = await prisma.reseller.findUnique({
      where: { id: currentId },
      select: { userId: true, // keep minimal
                // relasi parent ada di model Reseller? (di skema sebelumnya ada)
                // Kalau belum ada parentId di model final kamu, tambahkan field parentId & relasi Tree.
                // Berikut mengasumsikan sudah ada parentId.
                // Untuk compability, silakan tambah parentId di model Reseller.
                // Jika belum ada, return [] agar tidak bayar komisi ke upline.
                parentId: true,
                isActive: true }
    });

    if (!r?.parentId) break;
    const up = await prisma.reseller.findUnique({
      where: { id: r.parentId },
      select: { id: true, parentId: true, isActive: true }
    });
    if (!up || !up.isActive) break;

    chain.push({ level: level + 1, resellerId: up.id });
    currentId = up.id;
    level++;
  }
  return chain;
}

/**
 * Cari rule komisi flat milik upline untuk level tertentu dan product tertentu (override),
 * fallback ke rule global (productId null).
 * Model: CommissionFlat { resellerId, level, amount(BigInt), productId? }
 */
async function findFlatRuleFor(uplineId, productId, level) {
  // override per produk
  const override = await prisma.commissionFlat.findUnique({
    where: {
      resellerId_level_productId: {
        resellerId: uplineId,
        level,
        productId
      }
    }
  });
  if (override) return override;

  // global
  const global = await prisma.commissionFlat.findUnique({
    where: {
      resellerId_level_productId: {
        resellerId: uplineId,
        level,
        productId: null
      }
    }
  });
  return global || null;
}

/**
 * Worker utama.
 */
const worker = new Worker(
  'trx',
  async (job) => {
    if (job.name === 'dispatch') {
      const trx = await prisma.transaction.findUnique({ where: { id: job.data.trxId } });
      if (!trx || trx.status !== 'PENDING') return;

      // Pilih supplier
      const picked = await pickSupplier(trx.productId);
      if (!picked) {
        await prisma.transaction.update({ where: { id: trx.id }, data: { status: 'FAILED' } });
        await trxQueue.add('settlement', { trxId: trx.id }, { removeOnComplete: true, removeOnFail: true });
        return;
      }
      const { sp, ep } = picked;

      // Kirim order
      const resp = await sendToSupplier(ep, sp, trx);

      const updated = await prisma.transaction.update({
        where: { id: trx.id },
        data: {
          status: resp.status, // PROCESSING/SUCCESS/FAILED
          supplierId: sp.supplierId,
          supplierRef: resp.supplierRef,
          supplierPayload: { request: 'order' },
          supplierResult: resp.raw
        }
      });

      if (updated.status === 'PROCESSING') {
        await trxQueue.add('poll', { trxId: updated.id }, {
          delay: 10_000,
          attempts: 5,
          backoff: { type: 'exponential', delay: 15_000 },
          removeOnComplete: true,
          removeOnFail: true
        });
      } else {
        await trxQueue.add('settlement', { trxId: updated.id }, { removeOnComplete: true, removeOnFail: true });
      }
      return;
    }

    if (job.name === 'poll') {
      const trx = await prisma.transaction.findUnique({ where: { id: job.data.trxId } });
      if (!trx || trx.status !== 'PROCESSING') return;

      // TODO: Panggil endpoint status supplier (berdasarkan supplierRef).
      // DEMO: finalkan acak (ganti dengan request nyata).
      const final = Math.random() > 0.5;
      if (!final) return; // biarkan retry

      const success = Math.random() > 0.3;
      await prisma.transaction.update({
        where: { id: trx.id },
        data: { status: success ? 'SUCCESS' : 'FAILED' }
      });

      await trxQueue.add('settlement', { trxId: trx.id }, { removeOnComplete: true, removeOnFail: true });
      return;
    }

    if (job.name === 'settlement') {
      const trx = await prisma.transaction.findUnique({ where: { id: job.data.trxId } });
      if (!trx) return;

      // Refund hold saldo kalau tidak sukses
      if (['FAILED', 'CANCELED', 'EXPIRED'].includes(trx.status)) {
        const saldo = await prisma.saldo.findUnique({ where: { resellerId: trx.resellerId } });
        await prisma.$transaction(async (tx) => {
          await tx.saldo.update({
            where: { resellerId: trx.resellerId },
            data: { amount: (saldo?.amount ?? 0n) + trx.sellPrice + trx.adminFee }
          });
          await tx.mutasiSaldo.create({
            data: {
              resellerId: trx.resellerId,
              trxId: trx.id,
              amount: (trx.sellPrice + trx.adminFee), // credit
              type: 'REFUND',
              note: `Refund ${trx.invoiceId}`
            }
          });
        });
        await notifyReseller(trx.id);
        return;
      }

      // SUCCESS → bayar komisi berdasarkan margin (flat amount per level, diatur upline)
      if (trx.status === 'SUCCESS') {
        // Hitung margin = sellPrice - costPrice - adminFee
        let costPrice = 0n;
        if (trx.supplierId) {
          const sp = await prisma.supplierProduct.findFirst({
            where: { supplierId: trx.supplierId, productId: trx.productId },
            select: { costPrice: true }
          });
          costPrice = BigInt(sp?.costPrice ?? 0n);
        }
        const sellPrice = BigInt(trx.sellPrice);
        const adminFee = BigInt(trx.adminFee);
        let margin = sellPrice - costPrice - adminFee;
        if (margin < 0n) margin = 0n;

        // Ambil chain upline (parent berantai). Jika model Reseller belum punya parentId, kosongkan chain.
        const chain = await getUplineChain(trx.resellerId, 10);

        const payouts = [];
        let remaining = margin;

        for (const { level, resellerId: uplineId } of chain) {
          const rule = await findFlatRuleFor(uplineId, trx.productId, level);
          if (!rule) continue;

          let amt = BigInt(rule.amount);
          if (amt <= 0n) continue;

          // clamp oleh sisa margin
          if (amt > remaining) amt = remaining;
          if (amt <= 0n) break;

          payouts.push({ level, uplineId, amount: amt });
          remaining -= amt;
          if (remaining <= 0n) break;
        }

        if (payouts.length) {
          await prisma.$transaction(async (tx) => {
            for (const p of payouts) {
              // update saldo upline
              const existing = await tx.saldo.findUnique({ where: { resellerId: p.uplineId } });
              const current = existing?.amount ?? 0n;

              await tx.saldo.upsert({
                where: { resellerId: p.uplineId },
                update: { amount: current + p.amount },
                create: { resellerId: p.uplineId, amount: p.amount }
              });

              // catat mutasi saldo (CREDIT)
              await tx.mutasiSaldo.create({
                data: {
                  resellerId: p.uplineId,
                  trxId: trx.id,
                  amount: p.amount,
                  type: 'CREDIT',
                  note: `Komisi L${p.level} ${trx.invoiceId}`
                }
              });

              // (opsional) ledger detail komisi: tambah model TransactionCommission jika mau
              // await tx.transactionCommission.create({ ... })
            }
          });
        }

        await notifyReseller(trx.id);
        return;
      }

      // Status lain: tidak ada aksi
      return;
    }
  },
  { connection }
);

// Logging
worker.on('completed', (job) => {
  console.log('✅ job done:', job.name, job.id);
});
worker.on('failed', (job, err) => {
  console.log('❌ job fail:', job?.name, job?.id, err?.message);
});
