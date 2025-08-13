// api/lib/effective-price.js
import prisma from '../prisma.js';

export async function defaultSellPrice(productId) {
  const p = await prisma.product.findUnique({ where: { id: productId } });
  if (!p) throw new Error('Produk tidak ditemukan');
  return BigInt(p.basePrice) + BigInt(p.margin ?? 0n);
}

export async function computeEffectiveSellPrice(resellerId, productId) {
  const base = await defaultSellPrice(productId);

  const stack = [];
  let cur = resellerId;
  while (cur) {
    const r = await prisma.reseller.findUnique({
      where: { id: cur }, select: { id: true, parentId: true, isActive: true }
    });
    if (!r || !r.isActive) break;
    stack.push(r);
    cur = r.parentId;
  }
  stack.reverse();

  let effective = base;
  const chain = [{ resellerId: null, markup: 0n, cumulative: base }];

  for (const r of stack) {
    const mk = await prisma.resellerMarkup.findUnique({
      where: { resellerId_productId: { resellerId: r.id, productId } }
    });
    const add = BigInt(mk?.markup ?? 0n);
    effective += add;
    chain.push({ resellerId: r.id, markup: add, cumulative: effective });
  }

  return { effectiveSell: effective, chain };
}
