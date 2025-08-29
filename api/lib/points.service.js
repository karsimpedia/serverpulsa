// api/lib/points.service.ts
import prisma from "../prisma.js";

export async function awardPointsForSuccess(trxId) {
  return prisma.$transaction(async (tx) => {
    const trx = await tx.transaction.findUnique({
      where: { id: trxId },
      include: { product: true },
    });
    if (!trx) throw new Error("Transaksi tidak ditemukan");
    if (trx.status !== "SUCCESS") return trx;             // hanya saat sukses
    if (trx.pointAwarded) return trx;                     // idempoten

    // ambil poin produk, snapshot ke transaksi
    const points = trx.pointGiven && trx.pointGiven > 0
      ? trx.pointGiven
      : (trx.product?.pointValue || 0);

    // kalau produk poin 0 → tidak usah catat apa-apa, tapi tetap tandai awarded supaya idempoten
    if (points <= 0) {
      await tx.transaction.update({
        where: { id: trx.id },
        data: { pointGiven: 0, pointAwarded: true },
      });
      return trx;
    }

    // pastikan record saldo reseller ada
    await tx.resellerPoint.upsert({
      where: { resellerId: trx.resellerId },
      create: { resellerId: trx.resellerId, balance: points },
      update: { balance: { increment: points } },
    });

    // catat jejak poin pada transaksi
    await tx.transactionPoint.create({
      data: {
        transactionId: trx.id,
        resellerId: trx.resellerId,
        productId: trx.productId,
        points,
      },
    });

    // update transaksi snapshot + flag
    await tx.transaction.update({
      where: { id: trx.id },
      data: {
        pointGiven: points,
        pointAwarded: true,
      },
    });

    return trx;
  });
}

export async function reversePointsOnRefund(trxId) {
  return prisma.$transaction(async (tx) => {
    const trx = await tx.transaction.findUnique({
      where: { id: trxId },
      include: { pointRecord: true },
    });
    if (!trx) throw new Error("Transaksi tidak ditemukan");
    if (trx.status !== "REFUNDED") return trx;           // hanya saat refunded
    if (!trx.pointAwarded) return trx;                   // belum pernah diberi poin, tidak perlu rollback
    if (trx.pointReversed) return trx;                   // idempoten

    const points = trx.pointRecord?.points ?? trx.pointGiven ?? 0;
    if (points > 0) {
      // kurangi saldo
      await tx.resellerPoint.upsert({
        where: { resellerId: trx.resellerId },
        create: { resellerId: trx.resellerId, balance: 0 - points },
        update: { balance: { decrement: points } },
      });
    }

    // tandai sudah di-rollback
    await tx.transaction.update({
      where: { id: trx.id },
      data: { pointReversed: true },
    });

    return trx;
  });
}
