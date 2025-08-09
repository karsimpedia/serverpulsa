// api/controllers/saldo.js
import prisma from "../prisma.js";
import { randomBytes } from "crypto";

/**
 * POST /api/admin/saldo/topup
 * body: { resellerId: string, amount: string|number, note?: string, reference?: string }
 */
export async function topupSaldoManual(req, res) {
  try {
    const { resellerId, amount, note, reference } = req.body;

    if (!resellerId) {
      return res.status(400).json({ error: "resellerId wajib." });
    }

    if (amount === undefined || amount === null || isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount wajib angka." });
    }

    // pastikan bulat & > 0
    const amt = BigInt(String(amount));
    if (amt <= 0n) {
      return res.status(400).json({ error: "amount harus > 0." });
    }

    // generate trx_id unik
    const trxId = `TOPUP-${Date.now()}-${randomBytes(4).toString("hex")}`;

    const result = await prisma.$transaction(async (tx) => {
      // validasi reseller
      const reseller = await tx.reseller.findUnique({
        where: { id: resellerId },
        select: { id: true, isActive: true },
      });
      if (!reseller || !reseller.isActive) {
        throw new Error("RESELLER_NOT_FOUND_OR_INACTIVE");
      }

      // pastikan saldo row ada
      const saldoRow = await tx.saldo.upsert({
        where: { resellerId },
        update: {},
        create: { resellerId, amount: BigInt(0) },
        select: { amount: true },
      });

      const beforeAmount = saldoRow.amount;         // BigInt
      const afterAmount  = beforeAmount + amt;      // BigInt

      // catat mutasi
      const mutasi = await tx.mutasiSaldo.create({
        data: {
          trxId,                // unik
          resellerId,
          type: "CREDIT",       // enum: CREDIT | DEBIT
          source: "MANUAL_TOPUP",
          amount: amt,
          beforeAmount,
          afterAmount,
          note: note ?? null,
          reference: reference ?? null,
          status: "SUCCESS",    // enum opsional: SUCCESS|FAILED|PENDING
        },
      });

      // update saldo (increment)
      await tx.saldo.update({
        where: { resellerId },
        data: { amount: { increment: amt } },
      });

      return { mutasi, afterAmount };
    });

    // kirim BigInt sebagai string
    return res.status(201).json({
      message: "Topup saldo manual berhasil.",
      trxId: result.mutasi.trxId,
      resellerId,
      amount: String(result.mutasi.amount),
      saldoAfter: String(result.afterAmount),
    });
  } catch (err) {
    if (err.message === "RESELLER_NOT_FOUND_OR_INACTIVE") {
      return res.status(404).json({ error: "Reseller tidak ditemukan / nonaktif." });
    }
    if (err.code === "P2003") {
      return res.status(400).json({ error: "Relasi tidak valid (resellerId?)." });
    }
    console.error("topupSaldoManual error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
