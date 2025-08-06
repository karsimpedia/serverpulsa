// FILE: api/worker/worker.js
const { Worker } = require("bullmq");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const axios = require("axios");

const worker = new Worker(
  "topup",
  async (job) => {
    const { topupId, phone, kodeProduk, supplier } = job.data;
    try {
      const response = await axios.post(supplier.url, {
        api_key: supplier.apiKey,
        kode_produk: kodeProduk,
        tujuan: phone,
        ref_id: topupId,
      });

      const status = response.data.status === "sukses" ? "success" : "failed";

      await prisma.topup.update({
        where: { id: topupId },
        data: {
          status,
          ref: response.data.trx_id || null,
        },
      });

      if (status === "failed") {
        const trx = await prisma.topup.findUnique({ where: { id: topupId } });

        await prisma.reseller.update({
          where: { id: trx.resellerId },
          data: { saldo: { increment: trx.price } },
        });

        await prisma.mutasiSaldo.create({
          data: {
            resellerId: trx.resellerId,
            amount: trx.price,
            type: "refund",
            note: `Refund gagal topup ${trx.phone}`,
            relatedTo: trx.id,
          },
        });
      }
    } catch (err) {
      console.error("Gagal kirim topup:", err);
    }
  },
  {
    connection: {
      host: "redis",
      port: 6379,
    },
  }
);