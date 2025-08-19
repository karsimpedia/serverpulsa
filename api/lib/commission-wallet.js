// api/lib/commission-wallet.js
import prisma from '../prisma.js';
import { computeEffectiveSellPrice } from './effective-price.js';

/**
 * Kredit komisi override berjenjang ke DOMPET KOMISI saat trx SUCCESS.
 * - Sumber nominal per level diambil dari computeEffectiveSellPrice().chain[i].markup (flat).
 * - Idempotent: kalau sudah ada TransactionCommission positif utk trx ini → skip.
 * - Menulis: CommissionBalance(+), CommissionMutation(EARN,+), TransactionCommission(+).
 */
export async function payOverrideToWalletForSuccessTrx(trxId) {
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { reseller: true, product: true }
  });
  if (!trx || trx.status !== 'SUCCESS') return;

  const { chain } = await computeEffectiveSellPrice(trx.resellerId, trx.productId);
  if (!chain || chain.length <= 1) return;

  await prisma.$transaction(async (tx) => {
    const already = await tx.transactionCommission.count({
      where: { transactionId: trx.id, amount: { gt: 0 } }
    });
    if (already > 0) return; // idempotent

    for (let i = 1; i < chain.length; i++) {
      const node = chain[i];
      const receiverId = node.resellerId;
      const amt = BigInt(String(node.markup ?? 0));
      if (!receiverId || amt <= 0n) continue;

      // dompet komisi ++
      const bal = await tx.commissionBalance.findUnique({ where: { resellerId: receiverId } });
      const before = BigInt(bal?.amount ?? 0n);
      const after  = before + amt;

      await tx.commissionBalance.upsert({
        where: { resellerId: receiverId },
        create: { resellerId: receiverId, amount: after },
        update: { amount: after }
      });

      await tx.commissionMutation.create({
        data: {
          resellerId: receiverId,
          transactionId: trx.id,
          type: 'EARN',
          amount: amt,
          beforeAmount: before,
          afterAmount: after,
          note: `Komisi override level ${i} trx ${trx.invoiceId}`
        }
      });

      await tx.transactionCommission.create({
        data: {
          transactionId: trx.id,
          resellerId: receiverId,
          level: i,
          amount: amt
        }
      });
    }
  }, { isolationLevel: 'Serializable' });
}



// === Tambahkan di file yang sama: api/lib/commission-wallet.js ===

/**
 * Tarik balik komisi dari DOMPET KOMISI berdasarkan transaksi.
 * - Jika reverseAmountAbs == null  → FULL reversal (sisa yang belum di-offset).
 * - Jika reverseAmountAbs > 0n    → reversal nominal absolut sebesar itu.
 * - allowNegative: jika false dan dompet komisi penerima kurang → throw.
 *
 * Catatan:
 *   - Menghormati reversal sebelumnya (idempotent).
 *   - Urutan debit: level 1, lalu 2, dst.
 */
export async function reverseCommissionFromWallet(
  trxId,
  reverseAmountAbs = null,
  { allowNegative = true } = {}
) {
  // Ambil semua ledger komisi trx ini
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: {
      commissions: { select: { resellerId: true, level: true, amount: true } },
    },
  });
  if (!trx) return;
  if (!trx.commissions?.length) return;

  // Hitung sisa (remaining) komisi per (resellerId, level):
  // remaining = sum(amount)  [positif payout, negatif reversal]
  const bucketMap = new Map(); // key: `${rid}#${lvl}` -> remaining(BigInt)
  for (const c of trx.commissions) {
    const key = `${c.resellerId}#${c.level}`;
    const cur = bucketMap.get(key) ?? 0n;
    bucketMap.set(key, cur + BigInt(c.amount));
  }

  // Buat list kandidat yang masih punya sisa > 0 (artinya pernah dibayar dan belum full di-offset)
  const items = [];
  for (const [key, remaining] of bucketMap.entries()) {
    if (remaining > 0n) {
      const [rid, lvlStr] = key.split('#');
      items.push({ resellerId: rid, level: Number(lvlStr), remaining });
    }
  }
  if (!items.length) return;

  // Urutkan by level ASC (1,2,3,...)
  items.sort((a, b) => a.level - b.level);

  // Tentukan target total reversal
  let target;
  if (reverseAmountAbs == null) {
    // FULL: total sisa seluruh penerima
    target = items.reduce((acc, it) => acc + it.remaining, 0n);
  } else {
    // PARTIAL absolut
    target = BigInt(
      typeof reverseAmountAbs === 'string'
        ? reverseAmountAbs.trim()
        : String(Math.floor(Number(reverseAmountAbs || 0)))
    );
  }
  if (target <= 0n) return;

  // Eksekusi reversal atomik
  await prisma.$transaction(async (tx) => {
    let left = target;

    for (const it of items) {
      if (left <= 0n) break;

      // Ambil sebanyak mungkin dari "remaining" level ini, tapi tidak melebihi sisa target.
      const take = it.remaining >= left ? left : it.remaining;
      if (take <= 0n) continue;

      // Debit dompet komisi penerima
      const bal = await tx.commissionBalance.findUnique({
        where: { resellerId: it.resellerId },
        select: { amount: true },
      });
      const before = BigInt(bal?.amount ?? 0n);
      const after = before - take;

      if (!allowNegative && after < 0n) {
        throw new Error(
          `Dompet komisi reseller ${it.resellerId} tidak cukup untuk reversal level ${it.level}`
        );
      }

      await tx.commissionBalance.upsert({
        where: { resellerId: it.resellerId },
        create: { resellerId: it.resellerId, amount: after },
        update: { amount: after },
      });

      // Mutasi dompet: REVERSAL (amount negatif)
      await tx.commissionMutation.create({
        data: {
          resellerId: it.resellerId,
          transactionId: trx.id,
          type: 'REVERSAL',
          amount: -take, // simpan negatif
          beforeAmount: before,
          afterAmount: after,
          note: `Reversal komisi level ${it.level} trx ${trx.invoiceId}`,
        },
      });

      // Ledger per-transaksi offset: amount negatif
      await tx.transactionCommission.create({
        data: {
          transactionId: trx.id,
          resellerId: it.resellerId,
          level: it.level,
          amount: -take,
        },
      });

      left -= take;
    }
  }, { isolationLevel: 'Serializable' });
}
