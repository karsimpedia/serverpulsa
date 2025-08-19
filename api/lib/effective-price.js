// api/lib/effective-price.js
import prisma from '../prisma.js';

export async function defaultSellPrice(productId) {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    select: { basePrice: true, margin: true }
  });
  if (!p) throw new Error('Produk tidak ditemukan');
  return BigInt(p.basePrice) + BigInt(p.margin ?? 0n);
}

/**
 * Hitung harga efektif dan breakdown markup per level.
 * chain[0] = BUYER (reseller yg bertransaksi), level=0
 * chain[1] = UPLINE L1, dst (hanya reseller isActive)
 *
 * Opsi:
 *  - maxLevels: batasi kedalaman upline (default 10 biar aman)
 */
export async function computeEffectiveSellPrice(
  resellerId,
  productId,
  { maxLevels = 10 } = {}
) {
  const base = await defaultSellPrice(productId);

  // 1) Kumpulkan rantai buyer -> upline (hindari loop & batasi level)
  const nodes = []; // [{id, parentId}]
  let cur = resellerId;
  const seen = new Set();
  for (let i = 0; i <= maxLevels && cur; i++) {
    if (seen.has(cur)) break; // guard siklus
    seen.add(cur);

    const r = await prisma.reseller.findUnique({
      where: { id: cur },
      select: { id: true, parentId: true, isActive: true }
    });
    if (!r) break;
    if (!r.isActive) break; // stop jika non-aktif

    nodes.push({ id: r.id, parentId: r.parentId });
    cur = r.parentId;
  }
  // nodes[0]=buyer, dst

  if (nodes.length === 0) {
    return { base, effectiveSell: base, buyerMarkup: 0n, uplineTotalMarkup: 0n, chain: [] };
  }

  // 2) Ambil semua markup sekaligus (hindari N+1)
  const resellerIds = nodes.map(n => n.id);
  const markups = await prisma.resellerMarkup.findMany({
    where: {
      productId,
      resellerId: { in: resellerIds }
    },
    select: { resellerId: true, markup: true }
  });
  const mkMap = new Map(markups.map(m => [m.resellerId, BigInt(m.markup ?? 0n)]));

  // 3) Bangun chain + hitung harga efektif
  let effective = base;
  let buyerMarkup = 0n;
  let uplineTotalMarkup = 0n;

  const chain = nodes.map((n, idx) => {
    const add = BigInt(mkMap.get(n.id) ?? 0n);
    effective += add;

    const role = idx === 0 ? 'BUYER' : 'UPLINE';
    const level = idx;

    if (role === 'BUYER') buyerMarkup += add; else uplineTotalMarkup += add;

    return {
      resellerId: n.id,
      role,          // 'BUYER' | 'UPLINE'
      level,         // 0 untuk buyer
      markup: add,   // markup pada level ini
      cumulative: effective
    };
  });

  return {
    base,
    effectiveSell: effective,
    buyerMarkup,
    uplineTotalMarkup,
    chain
  };
}
