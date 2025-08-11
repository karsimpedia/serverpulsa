// worker/worker.js
import "dotenv/config";
import axios from "axios";
import { Worker } from "bullmq";
import prisma from "../api/prisma.js";
import { connection, QUEUE_NAME, trxQueue } from "../queues.js";
import Redis from "ioredis";

const QNAME = QUEUE_NAME || "trxQueue";

console.log("🚀 Worker transaksi start …");

// ==== Realtime Pub/Sub (Redis) ====
const RT_CHANNEL = process.env.RT_CHANNEL || "trx_events";
const redisPub = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({
      host: process.env.REDIS_HOST || "redis",
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB || 0),
    });
redisPub.on("error", (e) => console.error("[redis:pub] error:", e?.message || e));

const safeNum = (v) => (v == null ? 0 : Number(v));
const toNum = (v) => (v == null ? null : Number(v));
const toBI = (v) => (typeof v === "bigint" ? v : BigInt(v || 0));

const mapTrx = (t) => ({
  id: t.id,
  invoiceId: t.invoiceId,
  resellerId: t.resellerId,
  supplierId: t.supplierId || null,
  productCode: t.productCode || (t.product?.code ?? null),
  msisdn: t.msisdn,
  amount: safeNum(t.amount ?? t.nominal ?? t.sellPrice),
  price: safeNum(t.price ?? t.sellPrice),
  status: t.status,
  message: t.message ?? null,
  supplierRef: t.supplierRef ?? null,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

async function publish(evt, payload) {
  try {
    await redisPub.publish(RT_CHANNEL, JSON.stringify({ evt, payload, ts: Date.now() }));
  } catch (e) {
    console.error("publish error:", e?.message || e);
  }
}
const publishTrxNew = (trx) => publish("trx:new", mapTrx(trx));
const publishTrxUpdate = (trx) => publish("trx:update", mapTrx(trx));
const requestStatsRefresh = () => publish("stats:refresh", {});

// ==== Worker BullMQ ====
const worker = new Worker(
  QNAME,
  async (job) => {
    const { name, data } = job;

    if (name === "dispatch") return handleDispatchTopup(data.trxId);
    if (name === "dispatch_paybill") return handleDispatchPaybill(data.trxId);
    if (name === "poll_inquiry") return handlePollInquiry(data.trxId);

    console.warn(`⚠️  Unknown job: ${name}`);
  },
  { connection }
);

// ---- event logs
worker.on("completed", (job) => console.log(`🎯 ${job.name}(${job.id}) done`));
worker.on("failed", (job, err) => console.error(`💥 ${job?.name}(${job?.id}) failed:`, err?.message));

// -------- utils

/**
 * Ambil supplier-product yang available + endpoint aktif dengan prioritas/cost terendah.
 */
async function pickSupplierWithEndpoint(productId) {
  const list = await prisma.supplierProduct.findMany({
    where: { productId, isAvailable: true, supplier: { status: "ACTIVE" } },
    include: { supplier: { include: { endpoints: true } } },
    orderBy: [{ priority: "asc" }, { costPrice: "asc" }],
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
 * Helper: CREDIT (tambah saldo) atomic.
 */
async function createMutasiCredit(tx, { trxId, resellerId, amount, type = "CREDIT", source, note, reference }) {
  await ensureSaldo(tx, resellerId);
  const amt = toBI(amount);
  const updated = await tx.saldo.update({
    where: { resellerId },
    data: { amount: { increment: amt } },
    select: { amount: true },
  });
  const afterAmount = updated.amount;
  const beforeAmount = afterAmount - amt;

  return tx.mutasiSaldo.create({
    data: {
      trxId,
      resellerId,
      type,
      source,
      amount: amt,
      beforeAmount,
      afterAmount,
      note: note ?? null,
      reference: reference ?? null,
    },
  });
}

/**
 * Helper: DEBIT (kurangi saldo) atomic.
 */
async function createMutasiDebit(
  tx,
  { trxId, resellerId, amount, type = "DEBIT", source, note, reference, cekBalance = false }
) {
  await ensureSaldo(tx, resellerId);
  const amt = toBI(amount);

  if (cekBalance) {
    const cur = await tx.saldo.findUnique({ where: { resellerId }, select: { amount: true } });
    if ((cur?.amount ?? 0n) < amt) throw new Error("Saldo tidak cukup untuk debit.");
  }

  const updated = await tx.saldo.update({
    where: { resellerId },
    data: { amount: { decrement: amt } },
    select: { amount: true },
  });
  const afterAmount = updated.amount;
  const beforeAmount = afterAmount + amt;

  return tx.mutasiSaldo.create({
    data: {
      trxId,
      resellerId,
      type,
      source,
      amount: amt,
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

  const terminal = ["SUCCESS", "FAILED", "REFUNDED", "CANCELED", "EXPIRED"];
  if (!terminal.includes(trx.status)) return;

  if (["FAILED", "CANCELED", "EXPIRED"].includes(trx.status)) {
    const need = (trx.sellPrice ?? 0n) + (trx.adminFee ?? 0n); // BigInt aman

    // Satu REFUND per trx
    const refunded = await prisma.mutasiSaldo.findFirst({
      where: { trxId: trx.id, type: "REFUND" },
      select: { id: true },
    });

    if (!refunded && need > 0n) {
      await prisma.$transaction(async (tx) => {
        await createMutasiCredit(tx, {
          trxId: trx.id,
          resellerId: trx.resellerId,
          amount: need,
          type: "REFUND",
          source: "REFUND_TRX",
          note: `Refund ${trx.invoiceId}`,
          reference: trx.supplierRef || trx.invoiceId,
        });
      });
      console.log(`↩️  Refund selesai (${trx.invoiceId}) sebesar ${need.toString()}`);
      await requestStatsRefresh();
    }
  }

  // TODO: payout komisi saat SUCCESS
}

// -------- handlers
async function handleDispatchTopup(trxId) {
  const trx = await prisma.transaction.findUnique({ where: { id: trxId }, include: { product: true } });
  if (!trx) throw new Error(`Transaksi ${trxId} tidak ditemukan.`);
  if (!["PENDING", "PROCESSING"].includes(trx.status)) return;

  const picked = await pickSupplierWithEndpoint(trx.productId);
  if (!picked) {
    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: "FAILED", supplierResult: { error: "No available supplier/endpoint" } },
    });
    await publishTrxUpdate(updated);
    await requestStatsRefresh();
    await settlement(trx.id);
    return;
  }
  const { sp, ep } = picked;
  const url = `${ep.baseUrl.replace(/\/+$/, "")}/order`;
  const headers = ep.apiKey ? { "x-api-key": ep.apiKey } : {};
  const body = { ref: trx.invoiceId, sku: sp.supplierSku, msisdn: trx.msisdn, amount: toNum(trx.sellPrice) };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 15000 });
    const st = String(data?.status || "").toUpperCase();
    const normalized = ["SUCCESS", "FAILED", "PROCESSING"].includes(st) ? st : "PROCESSING";

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

    await publishTrxUpdate(updated);
    await requestStatsRefresh();

    if (updated.status === "PROCESSING") {
      await trxQueue.add("poll_inquiry", { trxId: updated.id }, { delay: 10_000, removeOnComplete: true, removeOnFail: true });
    } else {
      await settlement(updated.id);
    }
  } catch (err) {
    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: {
        status: "FAILED",
        supplierId: sp.supplierId,
        supplierPayload: { endpoint: url, request: body },
        supplierResult: { error: String(err?.message || err) },
      },
    });
    await publishTrxUpdate(updated);
    await requestStatsRefresh();
    await settlement(trx.id);
  }
}

async function handlePollInquiry(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: true },
  });
  if (!trx) throw new Error(`Transaksi ${trxId} tidak ditemukan.`);

  // cari endpoint aktif:
  // - jika ada supplierId pada transaksi → ambil endpoints supplier tsb
  // - kalau tidak / tidak aktif → fallback ke pickSupplierWithEndpoint(productId)
  let ep = null;
  if (trx.supplierId) {
    try {
      const sup = await prisma.supplier.findUnique({
        where: { id: trx.supplierId },
        include: { endpoints: true },
      });
      ep = sup?.endpoints?.find((e) => e.isActive) || null;
    } catch {
      ep = null;
    }
  }
  if (!ep) {
    const picked = await pickSupplierWithEndpoint(trx.productId);
    ep = picked?.ep || null;
  }
  if (!ep) {
    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: "FAILED", supplierResult: { error: "No endpoint for polling" } },
    });
    await publishTrxUpdate(updated);
    await requestStatsRefresh();
    await settlement(trx.id);
    return;
  }

  const url = `${ep.baseUrl.replace(/\/+$/, "")}/status`;
  const headers = ep.apiKey ? { "x-api-key": ep.apiKey } : {};
  const body = { ref: trx.supplierRef || trx.invoiceId, invoiceId: trx.invoiceId };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 12000 });
    const st = String(data?.status || "").toUpperCase();
    const normalized = st === "SUCCESS" ? "SUCCESS" : st === "FAILED" ? "FAILED" : "PROCESSING";

    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: normalized, supplierResult: data, updatedAt: new Date() },
    });

    await publishTrxUpdate(updated);
    await requestStatsRefresh();

    if (updated.status === "PROCESSING") {
      if (updated.expiresAt && updated.expiresAt.getTime() < Date.now()) {
        const upd = await prisma.transaction.update({
          where: { id: updated.id },
          data: { status: "FAILED", supplierResult: { note: "Expired TTL" } },
        });
        await publishTrxUpdate(upd);
        await requestStatsRefresh();
        await settlement(upd.id);
      } else {
        await trxQueue.add("poll_inquiry", { trxId: updated.id }, { delay: 15_000, removeOnComplete: true, removeOnFail: true, attempts: 1 });
      }
    } else {
      await settlement(updated.id);
    }
  } catch (err) {
    console.error("poll_inquiry error:", err?.message || err);
    await trxQueue.add("poll_inquiry", { trxId }, { delay: 20_000, removeOnComplete: true, removeOnFail: true, attempts: 1 });
  }
}

async function handleDispatchPaybill(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: true },
  });
  if (!trx) throw new Error(`Transaksi paybill ${trxId} tidak ditemukan.`);

  let ep = null;
  if (trx.supplierId) {
    try {
      const sup = await prisma.supplier.findUnique({
        where: { id: trx.supplierId },
        include: { endpoints: true },
      });
      ep = sup?.endpoints?.find((e) => e.isActive) || null;
    } catch {
      ep = null;
    }
  }
  if (!ep) {
    const picked = await pickSupplierWithEndpoint(trx.productId);
    ep = picked?.ep || null;
  }
  if (!ep) {
    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: "FAILED", supplierResult: { error: "No endpoint for pay" } },
    });
    await publishTrxUpdate(updated);
    await requestStatsRefresh();
    await settlement(trx.id);
    return;
  }

  const url = `${ep.baseUrl.replace(/\/+$/, "")}/pay`;
  const headers = ep.apiKey ? { "x-api-key": ep.apiKey } : {};
  const body = { ref: trx.invoiceId, supplierRef: trx.supplierRef, customerNo: trx.msisdn, amount: toNum(trx.sellPrice) };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 15000 });
    const st = String(data?.status || "").toUpperCase();
    const normalized = st === "SUCCESS" ? "SUCCESS" : st === "FAILED" ? "FAILED" : "PROCESSING";

    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: normalized, supplierResult: data, supplierPayload: { endpoint: url, request: body } },
    });

    await publishTrxUpdate(updated);
    await requestStatsRefresh();

    if (updated.status === "PROCESSING") {
      await trxQueue.add("poll_inquiry", { trxId: updated.id }, { delay: 10_000, removeOnComplete: true, removeOnFail: true });
    } else {
      await settlement(updated.id);
    }
  } catch (err) {
    const updated = await prisma.transaction.update({
      where: { id: trx.id },
      data: { status: "FAILED", supplierResult: { error: String(err?.message || err) }, supplierPayload: { endpoint: url, request: body } },
    });
    await publishTrxUpdate(updated);
    await requestStatsRefresh();
    await settlement(trx.id);
  }
}

// -------- graceful shutdown
process.on("SIGINT", async () => {
  console.log("SIGINT received. Closing worker…");
  try {
    await worker.close();
  } finally {
    try {
      await redisPub.quit();
    } catch {}
    process.exit(0);
  }
});
process.on("SIGTERM", async () => {
  console.log("SIGTERM received. Closing worker…");
  try {
    await worker.close();
  } finally {
    try {
      await redisPub.quit();
    } catch {}
    process.exit(0);
  }
});
