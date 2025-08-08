// worker/worker.js
import "dotenv/config.js";
import { Worker, QueueScheduler } from "bullmq";
import prisma from "../api/prisma.js";
import axios from "axios";
import { trxQueue } from "../../queues.js";

const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
};

// Pastikan QueueScheduler jalan biar job delayed/retry bisa dieksekusi
new QueueScheduler("trxQueue", { connection });

console.log("🚀 Worker transaksi & inquiry berjalan...");

// Worker utama
const trxWorker = new Worker(
  "trxQueue",
  async (job) => {
    if (job.name === "dispatch") {
      return await handleDispatch(job.data.trxId);
    }
    if (job.name === "poll_inquiry") {
      return await handlePollInquiry(job.data.trxId);
    }
  },
  { connection }
);

// ====== HANDLE DISPATCH TOPUP ======
async function handleDispatch(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: true, reseller: true },
  });
  if (!trx) throw new Error(`Transaksi ${trxId} tidak ditemukan.`);

  // TODO: kirim ke supplier sesuai product
  console.log(`⚡ Dispatch trx ${trx.invoiceId} -> ${trx.product.code}`);

  // Simulasi kirim ke supplier
  await new Promise((r) => setTimeout(r, 2000));

  // Update status success (dummy)
  await prisma.transaction.update({
    where: { id: trx.id },
    data: {
      status: "SUCCESS",
      supplierResult: { note: "Simulasi sukses dari worker" },
    },
  });

  console.log(`✅ Transaksi ${trx.invoiceId} sukses.`);
}

// ====== HANDLE POLLING INQUIRY ======
async function handlePollInquiry(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: {
      product: true,
      supplier: { include: { endpoints: true } },
    },
  });
  if (!trx) throw new Error(`Inquiry ${trxId} tidak ditemukan.`);
  if (!trx.supplierId) throw new Error(`Inquiry ${trxId} tidak punya supplierId.`);

  const ep = trx.supplier.endpoints.find((e) => e.isActive);
  if (!ep) throw new Error(`Supplier ${trx.supplier.name} tidak punya endpoint aktif.`);

  const url = `${ep.baseUrl.replace(/\/+$/, "")}/inquiry-status`;
  const headers = ep.apiKey ? { "x-api-key": ep.apiKey } : {};
  const body = { ref: trx.invoiceId };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 10000 });

    // Misal supplier balas lengkap → update status
    if (data.status === "OK") {
      await prisma.transaction.update({
        where: { id: trx.id },
        data: {
          status: "SUCCESS",
          supplierResult: data,
        },
      });
      console.log(`✅ Inquiry ${trx.invoiceId} selesai: SUCCESS`);
    } else if (data.status === "FAILED") {
      await prisma.transaction.update({
        where: { id: trx.id },
        data: {
          status: "FAILED",
          supplierResult: data,
        },
      });
      console.log(`❌ Inquiry ${trx.invoiceId} gagal.`);
    } else {
      // Kalau belum selesai, jadwalkan ulang polling (misal 15 detik lagi)
      console.log(`⏳ Inquiry ${trx.invoiceId} masih proses, retry 15 detik lagi...`);
      await trxQueue.add(
        "poll_inquiry",
        { trxId: trx.id },
        { delay: 15000, removeOnComplete: true, removeOnFail: true }
      );
    }
  } catch (err) {
    console.error(`Error polling inquiry ${trx.invoiceId}:`, err.message);
    // Retry polling
    await trxQueue.add(
      "poll_inquiry",
      { trxId: trx.id },
      { delay: 15000, removeOnComplete: true, removeOnFail: true }
    );
  }
}

trxWorker.on("completed", (job) => {
  console.log(`🎯 Job ${job.id} [${job.name}] selesai.`);
});

trxWorker.on("failed", (job, err) => {
  console.error(`💥 Job ${job?.id} [${job?.name}] gagal:`, err);
});
