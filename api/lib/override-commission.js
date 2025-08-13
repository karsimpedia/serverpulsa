// api/lib/override-commission.js
import prisma from '../prisma.js';
import { computeEffectiveSellPrice } from './effective-price.js';

export async function payOverrideForSuccessTrx(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { reseller: true, product: true }
  });
  if (!trx || trx.status !== 'SUCCESS') return;

  const { chain } = await computeEffectiveSellPrice(trx.resellerId, trx.productId);
  if (!chain || chain.length <= 1) return;

  const writes = [];
  for (let i = 1; i < chain.length; i++) {
    const node = chain[i];
    if (!node.resellerId) continue;
    const override = BigInt(node.markup || 0n);
    if (override <= 0n) continue;

    writes.push((async () => {
      const saldoRow = await prisma.saldo.findUnique({ where: { resellerId: node.resellerId } });
      const before = saldoRow?.amount ?? 0n;
      const after = before + override;

      await prisma.saldo.upsert({
        where: { resellerId: node.resellerId },
        create: { resellerId: node.resellerId, amount: after },
        update: { amount: after }
      });

      await prisma.mutasiSaldo.create({
        data: {
          trxId: trx.id,
          resellerId: node.resellerId,
          type: 'CREDIT',
          source: 'TRX_COMMISSION_OVERRIDE',
          amount: override,
          beforeAmount: before,
          afterAmount: after,
          note: `Override markup transaksi ${trx.invoiceId}`,
          status: 'SUCCESS'
        }
      });

      await prisma.transactionCommission.create({
        data: {
          transactionId: trx.id,
          resellerId: node.resellerId,
          level: i,
          amount: override
        }
      });
    })());
  }

  await Promise.all(writes);
}
