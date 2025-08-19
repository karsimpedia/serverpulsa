// api/controllers/refund.js
import prisma from "../prisma.js";
import { emitTrxUpdate } from "../lib/realtime.js";
import { reverseCommissionFromWallet } from "../lib/commission-wallet.js"; // ⬅️ gunakan wallet

export async function refundTransaction(req, res) {
  try {
    const { id } = req.params;
    const rawAmount = req.body?.amount; // opsional (partial refund)
    const rawCommReverse = req.body?.commissionReverseAmount; // opsional, ABSOLUT
    const reason = (req.body?.reason || "Manual refund").toString().slice(0, 280);

    const trx = await prisma.transaction.findUnique({
      where: { id },
      select: {
        id: true,
        invoiceId: true,
        resellerId: true,
        status: true,
        sellPrice: true,
        adminFee: true,
        createdAt: true,
      },
    });
    if (!trx) return res.status(404).json({ error: "Transaksi tidak ditemukan" });

    if (trx.status === "REFUNDED") {
      return res.status(409).json({ error: "Transaksi sudah direfund" });
    }

    if (trx.status === "FAILED") {
      return res.status(400).json({ error: "Transaksi FAILED tidak bisa direfund manual" });
    }

    // Nominal refund (default = sellPrice + adminFee), boleh partial via body.amount
    let refundAmount = (trx.sellPrice ?? 0n) + (trx.adminFee ?? 0n);
    if (rawAmount != null) {
      const n = typeof rawAmount === "string"
        ? rawAmount.trim()
        : String(Math.floor(Number(rawAmount || 0)));
      const bi = BigInt(n);
      if (bi <= 0n) return res.status(400).json({ error: "Nominal refund harus > 0" });
      if (bi > refundAmount) return res.status(400).json({ error: "Nominal refund melebihi jumlah yang dibayar" });
      refundAmount = bi;
    }

    let mutasiRow, saldoAfter, saldoBefore;
    await prisma.$transaction(async (tx) => {
      const saldo = await tx.saldo.findUnique({
        where: { resellerId: trx.resellerId },
        select: { amount: true },
      });
      const current = saldo?.amount ?? 0n;
      saldoBefore = current;
      saldoAfter = current + refundAmount;

      // Kredit balik saldo downline
      await tx.saldo.upsert({
        where: { resellerId: trx.resellerId },
        create: { resellerId: trx.resellerId, amount: saldoAfter },
        update: { amount: saldoAfter },
      });

      // Mutasi REFUND
      mutasiRow = await tx.mutasiSaldo.create({
        data: {
          trxId: trx.id,
          resellerId: trx.resellerId,
          type: "REFUND",
          source: "TRX_REFUND",
          amount: refundAmount,
          beforeAmount: saldoBefore,
          afterAmount: saldoAfter,
          note: `${reason} (inv:${trx.invoiceId})`,
          status: "SUCCESS",
        },
      });

      // Update status transaksi
      await tx.transaction.update({
        where: { id: trx.id },
        data: {
          status: "REFUNDED",
          message: reason,
        },
      });
    });

    // ==== Reversal KOMISI dari DOMPET KOMISI ====
    try {
      const totalPaid = (trx.sellPrice ?? 0n) + (trx.adminFee ?? 0n);
      const isFullRefund = refundAmount === totalPaid;

      if (isFullRefund) {
        // Full: reverse seluruh komisi yg belum di-offset untuk trx ini
        await reverseCommissionFromWallet(trx.id, null, { allowNegative: true });
      } else if (rawCommReverse != null) {
        // Partial: reverse sesuai NOMINAL absolut yang diminta admin
        const commAmt = BigInt(
          typeof rawCommReverse === "string"
            ? rawCommReverse.trim()
            : String(Math.floor(Number(rawCommReverse || 0)))
        );
        if (commAmt > 0n) {
          await reverseCommissionFromWallet(trx.id, commAmt, { allowNegative: true });
        }
      }
    } catch (e) {
      // Jangan gagalkan refund utama bila reversal komisi gagal
      console.error("reverseCommissionFromWallet error:", e?.message || e);
    }

    // Realtime → UI langsung berubah
    emitTrxUpdate(req.app.locals.trxNsp, {
      id: trx.id,
      invoiceId: trx.invoiceId,
      resellerId: trx.resellerId,
      status: "REFUNDED",
      message: reason,
      amount: Number(refundAmount),
    });

    return res.json({
      ok: true,
      trxId: trx.id,
      status: "REFUNDED",
      refund: {
        amount: Number(refundAmount),
        saldoBefore: Number(saldoBefore),
        saldoAfter: Number(saldoAfter),
        mutasiId: mutasiRow.id,
      },
      message: reason,
    });
  } catch (e) {
    console.error("refundTransaction error:", e);
    return res.status(500).json({ error: e?.message || "Gagal memproses refund" });
  }
}
