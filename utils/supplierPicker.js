// api/utils/supplierPicker.js
import prisma from '../api/prisma.js'

// Skor health: makin kecil makin baik
function healthScore(ep) {
  if (ep?.lastStatus === 'UP') return 0;
  if (ep?.lastStatus === 'DEGRADED') return 1;
  return 2; // DOWN/unknown
}

/**
 * pickSupplierWithEndpoint(productId)
 * - Digunakan di controller (synch call) untuk memilih 1 pasangan terbaik.
 * - Urutan: priority ASC -> healthScore -> latency -> costPrice ASC
 */
export async function pickSupplierWithEndpoint(productId) {
  const list = await prisma.supplierProduct.findMany({
    where: {
      productId,
      isAvailable: true,
      supplier: { status: 'ACTIVE', endpoints: { some: { isActive: true } } },
    },
    include: {
      supplier: { include: { endpoints: { where: { isActive: true } } } },
    },
  });

  if (!list.length) return null;

  // pilih endpoint terbaik per supplier (berdasar health & latency)
  const candidates = list.map(sp => {
    const eps = [...sp.supplier.endpoints].sort((a, b) =>
      (healthScore(a) - healthScore(b)) ||
      ((a.lastLatencyMs ?? 999999) - (b.lastLatencyMs ?? 999999))
    );
    const ep = eps[0];
    return ep ? { sp, ep } : null;
  }).filter(Boolean);

  if (!candidates.length) return null;

  // final sorting
  candidates.sort((a, b) =>
    (a.sp.priority - b.sp.priority) ||
    (healthScore(a.ep) - healthScore(b.ep)) ||
    ((a.ep.lastLatencyMs ?? 999999) - (b.ep.lastLatencyMs ?? 999999)) ||
    Number(a.sp.costPrice - b.sp.costPrice)
  );

  return candidates[0];
}

/**
 * pickCandidatesForWorker(productId)
 * - Dipakai worker untuk failover: kembalikan daftar kandidat berurutan.
 */
export async function pickCandidatesForWorker(productId) {
  const list = await prisma.supplierProduct.findMany({
    where: {
      productId,
      isAvailable: true,
      supplier: { status: 'ACTIVE', endpoints: { some: { isActive: true } } },
    },
    include: {
      supplier: { include: { endpoints: { where: { isActive: true } } } },
    },
  });

  const candidates = [];
  for (const sp of list) {
    if (!sp.supplier.endpoints.length) continue;
    const ep = [...sp.supplier.endpoints].sort((a, b) =>
      (healthScore(a) - healthScore(b)) ||
      ((a.lastLatencyMs ?? 999999) - (b.lastLatencyMs ?? 999999))
    )[0];
    if (ep) candidates.push({ sp, ep });
  }

  candidates.sort((a, b) =>
    (a.sp.priority - b.sp.priority) ||
    (healthScore(a.ep) - healthScore(b.ep)) ||
    ((a.ep.lastLatencyMs ?? 999999) - (b.ep.lastLatencyMs ?? 999999)) ||
    Number(a.sp.costPrice - b.sp.costPrice)
  );

  return candidates;
}
