// api/controllers/supplierProduct.controller.js
import prisma from "../prisma.js";

/** Parse ?include=product,supplier menjadi Prisma include aman dari BigInt */
function parseInclude(includeParam) {
  const inc = {};
  if (!includeParam) return inc;

  const tokens = String(includeParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const tk of tokens) {
    if (tk === "product") {
      // Hanya field yang dibutuhkan UI (hindari basePrice/margin yang BigInt)
      inc.product = { select: { id: true, code: true, name: true } };
    }
    if (tk === "supplier") {
      inc.supplier = { select: { id: true, code: true, name: true } };
    }
  }
  return inc;
}

function parseBool(v) {
  if (v === undefined) return undefined;
  const s = String(v).toLowerCase();
  if (["1", "true", "yes", "aktif"].includes(s)) return true;
  if (["0", "false", "no", "nonaktif"].includes(s)) return false;
  return undefined;
}

function buildWhere({ q, supplierId, productId, isActive }) {
  const where = {};
  if (supplierId) where.supplierId = String(supplierId);
  if (productId) where.productId = String(productId);

  const b = parseBool(isActive);
  if (typeof b === "boolean") where.isAvailable = b;

  const qNorm = String(q || "").trim();
  if (qNorm) {
    where.OR = [
      { supplierSku: { contains: qNorm, mode: "insensitive" } },
      { product: { code: { contains: qNorm, mode: "insensitive" } } },
      { product: { name: { contains: qNorm, mode: "insensitive" } } },
      { supplier: { name: { contains: qNorm, mode: "insensitive" } } },
    ];
  }
  return where;
}

function buildOrderBy({ orderBy, order }) {
  const ord = String(order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  if (orderBy) {
    if (["priority", "costPrice", "updatedAt"].includes(orderBy)) {
      return [{ [orderBy]: ord }];
    }
    if (orderBy === "supplier") return [{ supplier: { name: ord } }];
    if (orderBy === "product") return [{ product: { name: ord } }];
  }
  return [{ supplier: { name: "asc" } }, { priority: "asc" }, { product: { name: "asc" } }];
}

/** Mapper -> alias field untuk cocok dengan UI  */
function toClientRow(row) {
  return {
    id: row.id,
    productId: row.productId,
    supplierId: row.supplierId,
    supplierProductCode: row.supplierSku,                    // alias
    buyPrice: row.costPrice != null ? Number(row.costPrice) : null, // BigInt -> Number
    priority: row.priority,
    isActive: row.isAvailable,                                // alias
    // include aman (hanya select field non-BigInt)
    product: row.product || undefined,
    supplier: row.supplier || undefined,
  };
}

/**
 * GET /api/product-suppliers
 * Contoh: ?include=product,supplier&q=tsel&page=1&limit=500
 */
export async function listSupplierProducts(req, res) {
  try {
    const {
      include,
      q,
      supplierId,
      productId,
      isActive,
      page = 1,
      limit = 500,
      orderBy,
      order,
    } = req.query;

    const where = buildWhere({ q, supplierId, productId, isActive });
    const inc = parseInclude(include);
    const orderSpec = buildOrderBy({ orderBy, order });

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const take = Math.min(1000, Math.max(1, parseInt(limit, 10) || 500));
    const skip = (pageNum - 1) * take;

    const [total, rows] = await Promise.all([
      prisma.supplierProduct.count({ where }),
      prisma.supplierProduct.findMany({
        where,
        include: inc,
        orderBy: orderSpec,
        skip,
        take,
      }),
    ]);

    return res.json({
      items: rows.map(toClientRow),
      total,
      page: pageNum,
      limit: take,
      hasMore: skip + rows.length < total,
    });
  } catch (err) {
    console.error("GET /api/product-suppliers failed:", err);
    return res.status(500).json({ error: "Gagal mengambil data supplier products." });
  }
}

/**
 * POST /api/product-suppliers
 * Body: { productId, supplierId, supplierSku, costPrice?, priority?, isAvailable? }
 * Opsional: mode=upsert (query) untuk hindari error unique [supplierId, productId]
 */
export async function createSupplierProduct(req, res) {
  try {
    const { productId, supplierId, supplierSku, costPrice, priority = 100, isAvailable = true } =
      req.body || {};
    if (!productId || !supplierId || !supplierSku) {
      return res.status(400).json({ error: "productId, supplierId, supplierSku wajib." });
    }

    const mode = String(req.query.mode || "").toLowerCase();

    if (mode === "upsert") {
      const item = await prisma.supplierProduct.upsert({
        where: { supplierId_productId: { supplierId, productId } },
        create: {
          productId,
          supplierId,
          supplierSku: String(supplierSku).trim(),
          costPrice: typeof costPrice !== "undefined" ? BigInt(costPrice) : BigInt(0),
          priority: Number(priority) || 100,
          isAvailable: Boolean(isAvailable),
        },
        update: {
          supplierSku: String(supplierSku).trim(),
          ...(typeof costPrice !== "undefined" ? { costPrice: BigInt(costPrice) } : {}),
          ...(priority !== undefined ? { priority: Number(priority) || 100 } : {}),
          ...(isAvailable !== undefined ? { isAvailable: Boolean(isAvailable) } : {}),
        },
        include: { product: { select: { id: true, code: true, name: true } }, supplier: { select: { id: true, code: true, name: true } } },
      });
      return res.status(201).json({ item: toClientRow(item) });
    }

    const created = await prisma.supplierProduct.create({
      data: {
        productId,
        supplierId,
        supplierSku: String(supplierSku).trim(),
        costPrice: typeof costPrice !== "undefined" ? BigInt(costPrice) : BigInt(0),
        priority: Number(priority) || 100,
        isAvailable: Boolean(isAvailable),
      },
      include: { product: { select: { id: true, code: true, name: true } }, supplier: { select: { id: true, code: true, name: true } } },
    });

    return res.status(201).json({ item: toClientRow(created) });
  } catch (err) {
    console.error("POST /api/product-suppliers failed:", err);
    if (String(err?.code) === "P2002") {
      return res.status(409).json({ error: "Mapping supplierId+productId sudah ada. Gunakan mode=upsert." });
    }
    return res.status(500).json({ error: "Gagal membuat supplier product." });
  }
}

/**
 * PATCH /api/product-suppliers/:id
 * Body boleh berisi salah satu: supplierSku, costPrice, priority, isAvailable, productId, supplierId
 */
export async function updateSupplierProduct(req, res) {
  try {
    const { id } = req.params;
    const data = {};
    const allow = ["supplierSku", "costPrice", "priority", "isAvailable", "productId", "supplierId"];
    for (const key of allow) {
      if (key in req.body) {
        if (key === "costPrice" && req.body[key] != null) data[key] = BigInt(req.body[key]);
        else if (key === "priority" && req.body[key] != null) data[key] = Number(req.body[key]);
        else if (key === "isAvailable" && req.body[key] != null) data[key] = Boolean(req.body[key]);
        else data[key] = req.body[key];
      }
    }

    const updated = await prisma.supplierProduct.update({
      where: { id },
      data,
      include: { product: { select: { id: true, code: true, name: true } }, supplier: { select: { id: true, code: true, name: true } } },
    });

    return res.json({ item: toClientRow(updated) });
  } catch (err) {
    console.error("PATCH /api/product-suppliers/:id failed:", err);
    if (String(err?.code) === "P2025") {
      return res.status(404).json({ error: "Data tidak ditemukan." });
    }
    if (String(err?.code) === "P2002") {
      return res.status(409).json({ error: "Kombinasi supplierId+productId sudah dipakai." });
    }
    return res.status(500).json({ error: "Gagal memperbarui supplier product." });
  }
}

/** DELETE /api/product-suppliers/:id */
export async function deleteSupplierProduct(req, res) {
  try {
    const { id } = req.params;
    await prisma.supplierProduct.delete({ where: { id } });
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/product-suppliers/:id failed:", err);
    if (String(err?.code) === "P2025") {
      return res.status(404).json({ error: "Data tidak ditemukan." });
    }
    return res.status(500).json({ error: "Gagal menghapus supplier product." });
  }
}
