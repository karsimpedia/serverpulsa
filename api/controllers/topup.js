// api/controllers/topup.js
import prisma from "../prisma.js";

import { trxQueue } from "../../queues.js";
import bcrypt from "bcrypt";
export async function createTopup(req, res) {
  const { productCode, msisdn, refId, pin } = req.body;
  const resellerId = req.body.resellerId;

  if (!productCode || !msisdn) {
    return res.status(400).json({ error: "productCode & msisdn wajib." });
  }
  if (!pin) {
    return res.status(400).json({ error: "PIN wajib." });
  }
  if (!/^\d{6}$/.test(String(pin))) {
    return res.status(400).json({ error: "PIN harus 6 digit angka." });
  }
  try {
    // 0) Verifikasi PIN reseller
    const reseller = await prisma.reseller.findUnique({
      where: { id: resellerId },
      select: { id: true, pin: true, isActive: true },
    });
    if (!reseller || !reseller.isActive) {
      return res.status(403).json({ error: "Reseller tidak aktif." });
    }
    if (!reseller.pin) {
      return res.status(403).json({ error: "PIN belum diset. Hubungi admin." });
    }
    const okPin = await bcrypt.compare(String(pin), reseller.pin);
    if (!okPin) {
      return res.status(403).json({ error: "PIN salah." });
    }
    // 0) Ambil product lebih dulu (perlu productId untuk limit)
    const product = await prisma.product.findUnique({
      where: { code: productCode },
    });
    if (!product || !product.isActive) {
      return res.status(400).json({ error: "Produk tidak tersedia." });
    }

    // 1) Jika ada refId → idempotensi per reseller
    if (refId) {
      const existingByRef = await prisma.transaction.findFirst({
        where: { resellerId, externalRefId: refId },
        select: { invoiceId: true, status: true },
      });
      if (existingByRef) {
        return res.json({
          invoiceId: existingByRef.invoiceId,
          status: existingByRef.status,
          reused: true,
        });
      }
      // tidak ada → lanjut (refId baru = bypass limit)
    } else {
      // 2) TANPA refId → batasi 1 jam untuk KOMBINASI (productCode + msisdn) per reseller
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const blockingStatuses = ["PENDING", "PROCESSING", "SUCCESS"];

      const recent = await prisma.transaction.findFirst({
        where: {
          resellerId,
          productId: product.id, // ← per produk
          msisdn, // ← per nomor
          createdAt: { gt: oneHourAgo },
          status: { in: blockingStatuses },
        },
        select: { createdAt: true, invoiceId: true, status: true },
      });

      if (recent) {
        const elapsedMs = Date.now() - new Date(recent.createdAt).getTime();
        const remainingMs = Math.max(0, 60 * 60 * 1000 - elapsedMs);
        const remainingMin = Math.ceil(remainingMs / 60000);

        return res.status(429).json({
          error:
            "Tanpa refId, topup ke kombinasi produk+nomor ini dibatasi 1x per 1 jam.",
          detail: { productCode, msisdn },
          retryAfterMinutes: remainingMin,
          lastInvoiceId: recent.invoiceId,
          lastStatus: recent.status,
          tip: "Kirim refId unik di body untuk mengizinkan multiple topup di jam yang sama.",
        });
      }
    }

    // 3) Validasi saldo & harga
    const saldo = await prisma.saldo.findUnique({ where: { resellerId } });
    if (!saldo)
      return res.status(400).json({ error: "Saldo tidak ditemukan." });

    const sellPrice = BigInt(product.basePrice) + BigInt(product.margin);
    const adminFee = 0n;
    if (saldo.amount < sellPrice + adminFee) {
      return res.status(400).json({ error: "Saldo tidak cukup." });
    }

    // 4) Buat transaksi + hold saldo
    const invoiceId = `TRX-${Date.now()}`;

    try {
      const trx = await prisma.$transaction(async (tx) => {
        // ambil ulang saldo di dalam transaksi (hindari race)
        const saldoRow = await tx.saldo.findUnique({
          where: { resellerId },
          select: { amount: true },
        });
        if (!saldoRow) throw new Error("SALDO_NOT_FOUND");

        const holdAmount =
          BigInt(String(product.basePrice)) +
          BigInt(String(product.margin)) +
          0n; // = sellPrice + adminFee
        if (saldoRow.amount < holdAmount)
          throw new Error("INSUFFICIENT_BALANCE");

        // buat transaksi dulu
        const created = await tx.transaction.create({
          data: {
            invoiceId,
            resellerId,
            productId: product.id,
            msisdn,
            sellPrice:
              BigInt(String(product.basePrice)) +
              BigInt(String(product.margin)),
            adminFee: 0n,
            status: "PENDING",
            externalRefId: refId ?? null,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          },
        });

        const beforeAmount = saldoRow.amount;
        const afterAmount = beforeAmount - holdAmount;

        // update saldo: atomic decrement
        await tx.saldo.update({
          where: { resellerId },
          data: { amount: { decrement: holdAmount } },
        });

        // catat mutasi (pakai nilai positif untuk amount; tipe=DEBIT sudah menjelaskan arah)
        await tx.mutasiSaldo.create({
          data: {
            trxId: created.id,
            resellerId,
            type: "DEBIT",
            source: "HOLD_TRX",
            amount: holdAmount,
            beforeAmount,
            afterAmount,
            note: `Hold saldo untuk ${invoiceId}`,
            status: "SUCCESS",
          },
        });

        return created;
      });

      // 5) Enqueue ke worker
      await trxQueue.add(
        "dispatch",
        { trxId: trx.id },
        { removeOnComplete: true, removeOnFail: true }
      );
      return res.json({ invoiceId, status: "PENDING" });
    } catch (e) {
      if (e.message === "INSUFFICIENT_BALANCE") {
        return res.status(400).json({ error: "Saldo tidak cukup." });
      }
      if (e.message === "SALDO_NOT_FOUND") {
        return res.status(400).json({ error: "Saldo tidak ditemukan." });
      }
      // race condition pada refId
      if (e.code === "P2002" && refId) {
        const dup = await prisma.transaction.findFirst({
          where: { resellerId, externalRefId: refId },
          select: { invoiceId: true, status: true },
        });
        if (dup)
          return res.json({
            invoiceId: dup.invoiceId,
            status: dup.status,
            reused: true,
          });
      }
      throw e;
    }
  } catch (e) {
    console.error("Create topup error:", e);
    return res.status(500).json({ error: "Gagal membuat transaksi." });
  }
}
