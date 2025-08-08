// worker/commission.js
import prisma from '../api/prisma.js';

// dapatkan chain upline sampai maxLevels
export async function getUplineChain(resellerId, maxLevels) {
  const chain = [];
  let current = await prisma.reseller.findUnique({ where: { id: resellerId }, select: { parentId: true } });
  let level = 1;
  while (current?.parentId && level <= maxLevels) {
    const upline = await prisma.reseller.findUnique({
      where: { id: current.parentId },
      select: { id: true, parentId: true, isActive: true },
    });
    if (!upline || !upline.isActive) break;
    chain.push({ level, resellerId: upline.id });
    current = upline;
    level++;
  }
  return chain;
}

// ambil plan (reseller -> plan) atau default
export async function getCommissionPlanFor(resellerId) {
  const assign = await prisma.commissionPlanAssignment.findUnique({
    where: { resellerId },
    include: { plan: { include: { rules: true } } },
  });
  if (assign?.plan?.isActive) return assign.plan;

  // fallback: pakai plan global pertama yang aktif
  const def = await prisma.commissionPlan.findFirst({
    where: { isActive: true },
    include: { rules: true },
    orderBy: { createdAt: 'asc' },
  });
  return def;
}

// hitung komisi per level berdasarkan plan & product
export function computeLevelCommission({ plan, productId, sellPrice, margin }) {
  // filter rules untuk productId terlebih dahulu, fallback ke yang productId null
  const rulesByLevel = new Map();
  for (const r of plan.rules) {
    if (r.productId === productId || r.productId == null) {
      if (!rulesByLevel.has(r.level)) rulesByLevel.set(r.level, []);
      rulesByLevel.get(r.level).push(r);
    }
  }
  // untuk tiap level, pakai rule “paling spesifik” (utamakan yang productId cocok)
  const pickRule = (level) => {
    const arr = rulesByLevel.get(level);
    if (!arr || arr.length === 0) return null;
    // prefer rule dengan productId != null
    const spec = arr.find(x => x.productId != null);
    return spec || arr[0];
  };

  return (level) => {
    const rule = pickRule(level);
    if (!rule) return 0n;
    if (rule.valueType === 'AMOUNT') return BigInt(rule.value);

    // PERCENT
    const base = plan.base === 'SELLPRICE' ? sellPrice : margin;
    return (BigInt(rule.value) * base) / 100n; // value = persen bulat
  };
}
