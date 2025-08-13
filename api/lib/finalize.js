// api/lib/finalize.js
import prisma from '../prisma.js';
import { payOverrideForSuccessTrx } from './override-commission.js';

async function findHoldAmount(trxId) {
  const hold = await prisma.mutasiSaldo.findFirst({
    where: { trxId, type: 'DEBIT', source: 'TRX_HOLD', status: 'SUCCESS' },
    orderBy: { createdAt: 'asc' }
  });
  if (!hold) throw new Error('Hold mutasi tidak ditemukan');
  return hold.amount;
}

export async function finalizeSuccess(trxId, { message, supplierResult }) {
  await prisma.$transaction(async (tx) => {
    await tx.transaction.update({
      where: { id: trxId },
      data: { status: 'SUCCESS', message: message || 'SUCCESS', supplierResult }
    });
  });
  await payOverrideForSuccessTrx(trxId);
}

export async function finalizeFailed(trxId, { message, supplierResult }) {
  await prisma.$transaction(async (tx) => {
    await tx.transaction.update({
      where: { id: trxId },
      data: { status: 'FAILED', message: message || 'FAILED', supplierResult }
    });

    const amount = await findHoldAmount(trxId);
    const trx = await tx.transaction.findUnique({ where: { id: trxId } });
    const saldo = await tx.saldo.findUnique({ where: { resellerId: trx.resellerId } });
    const before = saldo?.amount ?? 0n;
    const after = before + amount;

    await tx.saldo.upsert({
      where: { resellerId: trx.resellerId },
      create: { resellerId: trx.resellerId, amount: after },
      update: { amount: after }
    });

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
  });
}
