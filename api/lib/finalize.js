// api/lib/finalize.js
import prisma from '../prisma.js';

/**
 * Cari nominal hold (DEBIT TRX_HOLD) untuk trx ini.
 * Kalau tidak ketemu, kembalikan 0n (jangan lempar error supaya idempotent).
 */
async function findHoldAmount(trxId) {
  const hold = await prisma.mutasiSaldo.findFirst({
    where: { trxId, type: 'DEBIT', source: 'TRX_HOLD', status: 'SUCCESS' },
    orderBy: { createdAt: 'asc' }
  });
  return BigInt(hold?.amount ?? 0n);
}

/**
 * Tandai transaksi sukses + simpan supplierResult/message.
 * PENTING: Tidak ada payout komisi di sini.
 * Payout komisi dilakukan di worker setelah memanggil finalizeSuccess.
 */
export async function finalizeSuccess(trxId, { message, supplierResult } = {}) {
  await prisma.$transaction(async (tx) => {
    // Optional guard: hindari downgrade status
    const cur = await tx.transaction.findUnique({
      where: { id: trxId },
      select: { status: true }
    });
    if (!cur) throw new Error('Transaksi tidak ditemukan');

    // Jika sudah SUCCESS, anggap idempotent
    if (cur.status === 'SUCCESS') return;

    await tx.transaction.update({
      where: { id: trxId },
      data: {
        status: 'SUCCESS',
        message: message || 'SUCCESS',
        supplierResult
      }
    });
  });
}

/**
 * Tandai transaksi gagal + kembalikan hold ke saldo reseller.
 * Idempotent untuk refund: jika hold 0, tidak ada kredit balik.
 */
export async function finalizeFailed(trxId, { message, supplierResult } = {}) {
  await prisma.$transaction(async (tx) => {
    const trx = await tx.transaction.findUnique({
      where: { id: trxId },
      select: { id: true, resellerId: true, status: true }
    });
    if (!trx) throw new Error('Transaksi tidak ditemukan');

    // Update status → FAILED
    if (trx.status !== 'FAILED') {
      await tx.transaction.update({
        where: { id: trxId },
        data: {
          status: 'FAILED',
          message: message || 'FAILED',
          supplierResult
        }
      });
    } else {
      // Jika sudah FAILED, tetap lanjut cek apakah perlu refund hold (idempotent-safe)
    }

    // Kembalikan hold (jika ada)
    const amount = await findHoldAmount(trxId);
    if (amount > 0n) {
      const saldoRow = await tx.saldo.findUnique({
        where: { resellerId: trx.resellerId },
        select: { amount: true }
      });
      const before = BigInt(saldoRow?.amount ?? 0n);
      const after = before + amount;

      await tx.saldo.upsert({
        where: { resellerId: trx.resellerId },
        create: { resellerId: trx.resellerId, amount: after },
        update: { amount: after }
      });

      // Catat mutasi refund hold → CREDIT
      await tx.mutasiSaldo.create({
        data: {
          trxId,
          resellerId: trx.resellerId,
          type: 'CREDIT',
          source: 'TRX_REFUND',
          amount,
          beforeAmount: before,
          afterAmount: after,
          note: 'Refund otomatis karena transaksi FAILED',
          status: 'SUCCESS'
        }
      });
    }
  });
}
