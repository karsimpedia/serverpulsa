// api/controllers/myEffectivePrice.js
import prisma from "../prisma.js";

const MAX_PAGE_LIMIT = 200;

function toStr(n) { try { return n != null ? n.toString() : "0"; } catch { return "0"; } }

// === build chain buyer -> upline (aktif) ===
async function buildActiveChain(resellerId, { maxLevels = 10 } = {}) {
  const nodes = [];
  let cur = resellerId;
  const seen = new Set();
  for (let i = 0; i <= maxLevels && cur; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const r = await prisma.reseller.findUnique({
      where: { id: cur },
      select: { id: true, parentId: true, isActive: true }
    });
    if (!r || !r.isActive) break;
    nodes.push({ id: r.id, parentId: r.parentId });
    cur = r.parentId;
  }
  return nodes; // [buyer, upline1, ...]
}

// === hitung harga efektif utk sekumpulan produk milik 1 reseller ===
async function bulkComputeEffectiveForProducts({ resellerId, productIds, maxLevels = 10 }) {
  const chain = await buildActiveChain(resellerId, { maxLevels });
  if (!chain.length || !productIds.length) return { chain, results: new Map() };

  // base price
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isActive: true },
    select: { id: true, code: true, name: true, type: true, categoryId: true, basePrice: true, margin: true }
  });
  const baseMap = new Map(products.map(p => [p.id, BigInt(p.basePrice) + BigInt(p.margin ?? 0n)]));

  // markups (per-produk + global) utk semua node dalam chain
  const resellerIds = chain.map(n => n.id);
  const [perProduct, globals] = await Promise.all([
    prisma.resellerMarkup.findMany({
      where: { resellerId: { in: resellerIds }, productId: { in: productIds } },
      select: { resellerId: true, productId: true, markup: true }
    }),
    prisma.resellerGlobalMarkup.findMany({
      where: { resellerId: { in: resellerIds } },
      select: { resellerId: true, markup: true }
    })
  ]);
  const ppMap = new Map(perProduct.map(m => [`${m.resellerId}|${m.productId}`, BigInt(m.markup ?? 0n)]));
  const globalMap = new Map(globals.map(g => [g.resellerId, BigInt(g.markup ?? 0n)]));

  const results = new Map();
  for (const p of products) {
    const base = baseMap.get(p.id) ?? 0n;
    let effective = base;
    let buyerMarkup = 0n;
    let uplineTotalMarkup = 0n;

    const breakdown = chain.map((n, idx) => {
      const key = `${n.id}|${p.id}`;
      const add = ppMap.has(key) ? ppMap.get(key) : (globalMap.get(n.id) ?? 0n);
      effective += add;
      const role = idx === 0 ? "BUYER" : "UPLINE";
      if (role === "BUYER") buyerMarkup += add; else uplineTotalMarkup += add;
      return { resellerId: n.id, role, level: idx, markup: add };
    });

    results.set(p.id, {
      product: { id: p.id, code: p.code, name: p.name, type: p.type, categoryId: p.categoryId },
      base,
      buyerMarkup,
      uplineTotalMarkup,
      effectiveSell: effective,
      breakdown
    });
  }
  return { chain, results };
}

/**
 * GET /api/effective-price/me
 * Query:
 *  - resellerId (wajib untuk sekarang; nanti ganti req.user.resellerId)
 *  - type=PULSA|TAGIHAN
 *  - categoryId
 *  - q (search name/code)
 *  - page (default 1)
 *  - limit (default 50, max 200)
 *  - includeBreakdown=true|false (default false)
 */
export async function listMyEffectivePrice(req, res) {
  try {
    const resellerId = String(req.query.resellerId || "");
    if (!resellerId) return res.status(400).json({ error: "resellerId wajib" });

    const type = req.query?.type ? String(req.query.type).toUpperCase() : null;
    const categoryId = req.query?.categoryId || null;
    const q = req.query?.q ? String(req.query.q).trim() : null;

    const page = Math.max(parseInt(req.query?.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query?.limit || "50", 10), 1), MAX_PAGE_LIMIT);
    const skip = (page - 1) * limit;

    const where = { isActive: true };
    if (type) where.type = type;
    if (categoryId) where.categoryId = categoryId;
    if (q) where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { code: { contains: q, mode: "insensitive" } }
    ];

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: [{ type: "asc" }, { code: "asc" }],
        select: { id: true, code: true, name: true, type: true, categoryId: true, basePrice: true, margin: true },
        skip, take: limit
      }),
      prisma.product.count({ where })
    ]);
    if (!items.length) {
      return res.json({ ok: true, resellerId, page, limit, total, data: [] });
    }

    const productIds = items.map(p => p.id);
    const includeBreakdown = String(req.query?.includeBreakdown || "false").toLowerCase() === "true";

    const { results } = await bulkComputeEffectiveForProducts({
      resellerId,
      productIds,
      maxLevels: 10
    });

    let  product = items.map(p => {
      const r = results.get(p.id);
      if (!r) {
        const base = BigInt(p.basePrice) + BigInt(p.margin ?? 0n);
        return {
          product: { id: p.id, code: p.code, name: p.name, type: p.type, categoryId: p.categoryId, harga:  toStr(base)  },        
         
          effectiveSell: toStr(base),
          breakdown: includeBreakdown ? [] : undefined
        };
      }

      let datap= r.product
      return {
        // product: r.product,    
       ...datap,
        
        effectiveSell: toStr(r.effectiveSell),
        breakdown: includeBreakdown
          ? r.breakdown.map(b => ({
              resellerId: b.resellerId,             
            
            }))
          : undefined
      };
    });

    return res.json({
      ok: true,
      resellerId,
      page, limit, total,
      product
    });
  } catch (e) {
    console.error("listMyEffectivePrice error:", e);
    return res.status(500).json({ error: e.message || "Gagal mengambil harga efektif" });
  }
}
