// api/controllers/product.js
import prisma from "../prisma.js";
const MAX_PAGE_LIMIT = 200;
const DEFAULT_MAX_RESELLERS = Number(process.env.EP_MAX_RESELLERS || 50);

function toStr(n) {
  try { return n != null ? n.toString() : "0"; } catch { return "0"; }
}


export async function upsertCategory(req, res) {
  try {
    let { name, code } = req.body;
    if (!name) return res.status(400).json({ error: "Nama kategori wajib diisi" });

    name = name.trim().toUpperCase();
    if (code) code = code.trim().toUpperCase();

    const category = await prisma.productCategory.upsert({
      where: { name },
      update: { code },
      create: { name, code },
    });

    return res.status(200).json({ data: category });
  } catch (err) {
    console.error("Upsert kategori gagal:", err);
    return res.status(500).json({ error: "Upsert kategori gagal" });
  }
}

/** Ambil anak / seluruh keturunan dari ownerResellerId. */
async function listDescendants(ownerResellerId, mode = "children") {
  const result = [];
  const q = [ownerResellerId];
  let depth = 0;

  while (q.length && depth < 50) {
    const parents = q.splice(0, q.length);
    const children = await prisma.reseller.findMany({
      where: { parentId: { in: parents }, isActive: true },
      select: { id: true }
    });
    if (!children.length) break;

    const ids = children.map(c => c.id);
    result.push(...ids);

    if (mode === "all") q.push(...ids);
    depth++;
    if (mode === "children") break;
  }
  return result;
}

/** Bangun chain buyer -> upline (aktif) */
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

/** Hitung harga efektif untuk sekumpulan productIds milik satu reseller. */
async function bulkComputeEffectiveForProducts({ resellerId, productIds, maxLevels = 10 }) {
  const chain = await buildActiveChain(resellerId, { maxLevels });
  if (!chain.length || !productIds.length) return { chain, results: new Map() };

  // base
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isActive: true },
    select: { id: true, basePrice: true, margin: true, code: true, name: true, type: true, categoryId: true }
  });
  const baseMap = new Map(
    products.map(p => [p.id, BigInt(p.basePrice) + BigInt(p.margin ?? 0n)])
  );

  // markups
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
  const globalMap = new Map(globals.map(g => [g.resellerId, BigInt(g.markup ?? 0n)]));
  const ppMap = new Map(perProduct.map(m => [`${m.resellerId}|${m.productId}`, BigInt(m.markup ?? 0n)]));

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
 * GET /api/effective-price/downlines
 * Query:
 *  - ownerResellerId (wajib)
 *  - scope=children|all (default children)
 *  - resellerIds=<csv subset> (opsional)
 *  - type=PULSA|TAGIHAN, categoryId, q
 *  - page=1.., limit=1..200
 *  - includeBreakdown=true|false (dipakai hanya utk owner/self)
 *  - maxResellers (default 50)
 *
 * Catatan: TANPA auth middleware — tambahkan sendiri nanti.
 */
export async function listEffectivePriceForDownlines(req, res) {
  try {
    const ownerResellerId = String(req.query.ownerResellerId || "");
    if (!ownerResellerId) {
      return res.status(400).json({ error: "ownerResellerId wajib" });
    }

    const scope = (req.query.scope || "children").toString();
    const includeBreakdown = String(req.query.includeBreakdown || "false").toLowerCase() === "true";
    const maxResellers = Math.min(
      Math.max(parseInt(req.query.maxResellers || String(DEFAULT_MAX_RESELLERS), 10), 1),
      500
    );

    // ambil downlines
    let targets = await listDescendants(ownerResellerId, scope === "all" ? "all" : "children");

    // subset manual (opsional)
    if (req.query.resellerIds) {
      const subset = String(req.query.resellerIds).split(",").map(s => s.trim()).filter(Boolean);
      const set = new Set(subset);
      targets = targets.filter(rid => set.has(rid));
    }

    // batasi payload
    if (targets.length > maxResellers) targets = targets.slice(0, maxResellers);

    // jika tidak ada downline, tetap tampilkan “self” agar bisa lihat detail katalog sendiri
    const finalTargets = targets.length ? targets : [ownerResellerId];

    // filter produk
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
      return res.json({
        ok: true,
        ownerResellerId,
        scope,
        totalDownlines: targets.length,
        products: { page, limit, total },
        data: []
      });
    }

    const productIds = items.map(p => p.id);
    const data = [];

    for (const rid of finalTargets) {
      const { results } = await bulkComputeEffectiveForProducts({
        resellerId: rid,
        productIds,
        maxLevels: 10
      });

      const isSelf = (rid === ownerResellerId);

      const rows = items.map(p => {
        const r = results.get(p.id);
        if (!r) {
          const base = BigInt(p.basePrice) + BigInt(p.margin ?? 0n);
          return isSelf
            ? {
                product: { id: p.id, code: p.code, name: p.name, type: p.type, categoryId: p.categoryId },
                base: toStr(base),
                buyerMarkup: "0",
                uplineTotalMarkup: "0",
                effectiveSell: toStr(base),
                breakdown: includeBreakdown ? [] : undefined
              }
            : {
                product: { id: p.id, code: p.code, name: p.name, type: p.type, categoryId: p.categoryId },
                effectiveSell: toStr(base)
              };
        }

        return isSelf
          ? {
              product: r.product,
              base: toStr(r.base),
              buyerMarkup: toStr(r.buyerMarkup),
              uplineTotalMarkup: toStr(r.uplineTotalMarkup),
              effectiveSell: toStr(r.effectiveSell),
              breakdown: includeBreakdown
                ? r.breakdown.map(b => ({
                    resellerId: b.resellerId,
                    role: b.role,
                    level: b.level,
                    markup: toStr(b.markup)
                  }))
                : undefined
            }
          : {
              product: r.product,
              effectiveSell: toStr(r.effectiveSell)
            };
      });

      data.push({ resellerId: rid, products: rows });
    }

    return res.json({
      ok: true,
      ownerResellerId,
      scope,
      totalDownlines: targets.length,
      products: { page, limit, total },
      data
    });
  } catch (e) {
    console.error("listEffectivePriceForDownlines error:", e);
    return res.status(500).json({ error: e.message || "Gagal mengambil daftar harga efektif downline" });
  }
}




/** Helper: konversi BigInt ke Number untuk kirim ke client */
function toPlainProduct(p) {
  if (!p) return p;
  return {
    ...p,
    basePrice: p.basePrice != null ? Number(p.basePrice) : null,
    margin: p.margin != null ? Number(p.margin) : null,
  };
}
function toPlainProducts(rows) {
  return rows.map(toPlainProduct);
}

// Tambah produk
export async function createProduct(req, res) {
  try {
    let { code, name, type, nominal, basePrice, margin, isActive, categoryCode, categoryId } = req.body;

    if (!code || !name || !type || basePrice == null) {
      return res.status(400).json({ error: "Field wajib: code,name,type,basePrice" });
    }

    // Normalisasi
    code = String(code).trim().toUpperCase();
    const _name = String(name).trim();
    const allowedTypes = ["PULSA", "TAGIHAN"];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: "type harus PULSA atau TAGIHAN" });
    }

    const _nominal = nominal == null || nominal === "" ? null : Number(nominal);
    const _basePrice = BigInt(basePrice);
    const _margin = BigInt(margin ?? 0);
    const _isActive = typeof isActive === "boolean" ? isActive : true;

    // Cek kode produk unik
    const existed = await prisma.product.findUnique({ where: { code } });
    if (existed) {
      return res.status(409).json({ error: "Kode produk sudah terpakai." });
    }

    // Siapkan connect kategori (opsional)
    let categoryConnect = undefined;
    if (categoryId) {
      categoryConnect = { connect: { id: String(categoryId) } };
    } else if (categoryCode) {
      const catCode = String(categoryCode).trim().toUpperCase();
      const cat = await prisma.productCategory.findUnique({ where: { code: catCode } });
      if (!cat) {
        return res.status(404).json({ error: `Kategori dengan code "${catCode}" tidak ditemukan.` });
      }
      categoryConnect = { connect: { code: cat.code } }; // connect by unique code
    }

    const prod = await prisma.product.create({
      data: {
        code,
        name: _name,
        type,
        nominal: _nominal,
        basePrice: _basePrice,
        margin: _margin,
        isActive: _isActive,
        ...(categoryConnect ? { category: categoryConnect } : {}),
      },
      include: {
        category: { select: { id: true, code: true, name: true } },
      },
    });

    return res.status(201).json({ data: toPlainProduct(prod) });
  } catch (e) {
    if (e.code === "P2002" && e.meta?.target?.includes("code")) {
      return res.status(409).json({ error: "Kode produk sudah terpakai." });
    }
    if (e.code === "P2025") {
      // dependency not found (misal connect id tidak ada)
      return res.status(404).json({ error: "Kategori tidak ditemukan." });
    }
    console.error("Tambah produk gagal:", e);
    return res.status(500).json({ error: "Tambah produk gagal" });
  }
}




export async function upsertProduct(req, res) {
  try {
    let { code, name, type, nominal, basePrice, margin, isActive, categoryId, categoryName } = req.body;

    if (!code || !name || !type || basePrice == null) {
      return res.status(400).json({ error: "Field wajib: code,name,type,basePrice" });
    }

    code = String(code).trim().toUpperCase();
    const allowedTypes = ["PULSA", "TAGIHAN"];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: "type harus PULSA atau TAGIHAN" });
    }

    // Kalau user kirim categoryName → buat/upsert kategori
    if (!categoryId && categoryName) {
      const cat = await prisma.productCategory.upsert({
        where: { name: categoryName.trim().toUpperCase() },
        update: {},
        create: { name: categoryName.trim().toUpperCase() },
      });
      categoryId = cat.id;
    }

    const prod = await prisma.product.upsert({
      where: { code },
      update: {
        name,
        type,
        nominal: nominal ?? null,
        basePrice: BigInt(basePrice),
        margin: BigInt(margin ?? 0),
        isActive: isActive ?? true,
        categoryId: categoryId || null,
      },
      create: {
        code,
        name,
        type,
        nominal: nominal ?? null,
        basePrice: BigInt(basePrice),
        margin: BigInt(margin ?? 0),
        isActive: isActive ?? true,
        categoryId: categoryId || null,
      },
      include: { category: true },
    });

    return res.status(200).json({ data: prod });
  } catch (e) {
    console.error("Upsert produk gagal:", e);
    return res.status(500).json({ error: "Upsert produk gagal" });
  }
}



// Get all products
export async function getAllProducts(req, res) {
  try {
    const includeParam = String(req.query.include || "");
    const includeCategory = includeParam
      .split(",")
      .map(s => s.trim().toLowerCase())
      .includes("category");

    const groupBy = String(req.query.group || "").toLowerCase();
    const groupByCategory = groupBy === "category";

    const products = await prisma.product.findMany({
      orderBy: { createdAt: "desc" },
      include: includeCategory
        ? { category: { select: { id: true, code: true, name: true } } }
        : undefined,
    });

    if (groupByCategory) {
      // bentuk output: [{ key, label, items: Product[] }]
      const map = new Map();
      for (const p of products) {
        const key = p.category?.code ?? "__NO_CAT__";
        const label = p.category
          ? `${p.category.name} — ${p.category.code}`
          : "(Tanpa Kategori)";

        if (!map.has(key)) map.set(key, { label, items: [] });
        map.get(key).items.push(toPlainProduct(p, { includeCategory }));
      }

      const data = Array.from(map.entries())
        .sort((a, b) => a[1].label.localeCompare(b[1].label))
        .map(([key, grp]) => ({
          key,
          label: grp.label,
          items: grp.items.sort((a, b) => a.code.localeCompare(b.code)),
        }));

      return res.json({ data });
    }

    // default: list flat
    return res.json({
      data: products.map(p => toPlainProduct(p, { includeCategory })),
    });
  } catch (err) {
    console.error("Fetch products error:", err);
    return res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
}




// Get single product by ID
export async function getProduct(req, res) {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      return res.status(404).json({ error: "Produk tidak ditemukan." });
    }
    return res.json({ data: toPlainProduct(product) });
  } catch (err) {
    console.error("Fetch product error:", err);
    return res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
}

// Update product
export async function updateProduct(req, res) {
  try {
    const { id } = req.params;
    const { name, type, nominal, basePrice, margin, isActive } = req.body;

    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Produk tidak ditemukan." });
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if (type !== undefined) {
      const allowedTypes = ["PULSA", "TAGIHAN"];
      if (!allowedTypes.includes(type)) {
        return res.status(400).json({ error: "type harus PULSA atau TAGIHAN" });
      }
      data.type = type;
    }
    if (nominal !== undefined) data.nominal = nominal;
    if (basePrice !== undefined) data.basePrice = BigInt(basePrice);
    if (margin !== undefined) data.margin = BigInt(margin);
    if (isActive !== undefined) data.isActive = !!isActive;

    const updated = await prisma.product.update({ where: { id }, data });
    return res.json({ message: "Produk berhasil diperbarui", data: toPlainProduct(updated) });
  } catch (err) {
    console.error("Update product error:", err);
    return res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
}

// Delete product
export async function deleteProduct(req, res) {
  try {
    const { id } = req.params;
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Produk tidak ditemukan." });
    }

    await prisma.product.delete({ where: { id } });
    return res.json({ message: "Produk berhasil dihapus" });
  } catch (err) {
    console.error("Delete product error:", err);
    return res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
}
