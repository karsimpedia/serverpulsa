// api/utils/supplierPicker.js
import prisma from '../prisma.js';

function healthScore(ep) {
  if (ep?.lastStatus === 'UP') return 0;
  if (ep?.lastStatus === 'DEGRADED') return 1;
  return 2;
}

/**
 * Ambil kandidat untuk productId, diurut: priority -> health -> latency -> cost
 * Return list [{ supplierCode, sp, ep, ctxBase }]
 * ctxBase: { baseUrl, apiKey }
 */
export async function pickCandidatesForWorker(productId) {
  const sps = await prisma.supplierProduct.findMany({
    where: {
      productId,
      isAvailable: true,
      supplier: { status: 'ACTIVE', endpoints: { some: { isActive: true } } }
    },
    include: { supplier: { include: { endpoints: { where: { isActive: true } } } } }
  });

  const candidates = [];
  for (const sp of sps) {
    const ep = [...sp.supplier.endpoints].sort((a, b) =>
      (healthScore(a) - healthScore(b)) ||
      ((a.lastLatencyMs ?? 999999) - (b.lastLatencyMs ?? 999999))
    )[0];
    if (!ep) continue;
    candidates.push({
      supplierCode: sp.supplier.code, // penting utk lookup config JSON
      sp,
      ep,
      ctxBase: { baseUrl: ep.baseUrl, apiKey: ep.apiKey }
    });
  }

  candidates.sort((a, b) =>
    (a.sp.priority - b.sp.priority) ||
    (healthScore(a.ep) - healthScore(b.ep)) ||
    ((a.ep.lastLatencyMs ?? 999999) - (b.ep.lastLatencyMs ?? 999999)) ||
    Number(a.sp.costPrice - b.sp.costPrice)
  );

  return candidates;
}

/**
 * Pilih satu terbaik untuk pemanggilan singkat (non-failover)
 */
export async function pickSupplierWithEndpoint(productId) {
  const list = await pickCandidatesForWorker(productId);
  return list[0] || null;
}
