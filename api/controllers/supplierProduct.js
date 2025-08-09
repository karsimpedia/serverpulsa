// api/controllers/supplierProduct.js
import prisma from "../prisma.js";

/**
 * POST /api/admin/suppliers/:supplierId/products
 * Body:
 * {
 *   productCode: string,       // kode produk internal (wajib)
 *   supplierSku: string,       // kode produk versi supplier (wajib)
 *   costPrice: string|number,  // BigInt, wajib > 0
 *   isAvailable?: boolean,     // default true
 *   priority?: number          // default 100
 * }
 * - Upsert mapping (supplierId + productId)
 */
export async function upsertSupplierProduct(req, res) {
  try {
    const { supplierId } = req.params;
    const { productCode, supplierSku, costPrice, isAvailable, priority } = req.body;

    if (!supplierId) return res.status(400).json({ error: "supplierId tidak valid." });
    if (!productCode) return res.status(400).json({ error: "productCode wajib." });
    if (!supplierSku) return res.status(400).json({ error: "supplierSku wajib." });
    if (costPrice === undefined || costPrice === null || isNaN(Number(costPrice))) {
      return res.status(400).json({ error: "costPrice wajib angka." });
    }
    const cp = BigInt(String(costPrice));
    if (cp <= 0n) return res.status(400).json({ error: "costPrice harus > 0." });

    const mapping = await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({
        where: { id: supplierId },
        select: { id: true, status: true },
      });
      if (!supplier || supplier.status !== "ACTIVE") throw new Error("SUPPLIER_INACTIVE");

      const product = await tx.product.findUnique({
        where: { code: productCode },
        select: { id: true, isActive: true },
      });
      if (!product || !product.isActive) throw new Error("PRODUCT_INACTIVE");

      return tx.supplierProduct.upsert({
        where: { supplierId_productId: { supplierId: supplier.id, productId: product.id } },
        update: {
          supplierSku,
          costPrice: cp,
          ...(typeof isAvailable === "boolean" && { isAvailable }),
          ...(priority !== undefined && { priority: Number(priority) }),
          // updatedAt auto by @updatedAt
        },
        create: {
          supplierId: supplier.id,
          productId: product.id,
          supplierSku,
          costPrice: cp,
          isAvailable: typeof isAvailable === "boolean" ? isAvailable : true,
          priority: priority !== undefined ? Number(priority) : 100,
        },
        include: {
          supplier: { select: { id: true, name: true, code: true } },
          product: { select: { id: true, code: true, name: true, type: true } },
        },
      });
    });

    res.json({
      message: "SupplierProduct diupsert.",
      data: { ...mapping, costPrice: String(mapping.costPrice) },
    });
  } catch (err) {
    if (err.message === "SUPPLIER_INACTIVE") return res.status(404).json({ error: "Supplier tidak ditemukan/INACTIVE." });
    if (err.message === "PRODUCT_INACTIVE") return res.status(404).json({ error: "Produk tidak ditemukan/nonaktif." });
    if (err.code === "P2002") return res.status(409).json({ error: "Mapping duplikat." });
    console.error("upsertSupplierProduct error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

/**
 * PATCH /api/admin/suppliers/:supplierId/products/:productCode
 * Body: bisa salah satu/lebih dari { supplierSku, costPrice, isAvailable, priority }
 */
export async function patchSupplierProduct(req, res) {
  try {
    const { supplierId, productCode } = req.params;
    const { supplierSku, costPrice, isAvailable, priority } = req.body;

    const product = await prisma.product.findUnique({
      where: { code: productCode },
      select: { id: true },
    });
    if (!product) return res.status(404).json({ error: "Produk tidak ditemukan." });

    const data = {
      ...(supplierSku !== undefined && { supplierSku }),
      ...(costPrice !== undefined && { costPrice: BigInt(String(costPrice)) }),
      ...(typeof isAvailable === "boolean" && { isAvailable }),
      ...(priority !== undefined && { priority: Number(priority) }),
      // updatedAt otomatis
    };

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "Tidak ada field yang diubah." });
    }

    const updated = await prisma.supplierProduct.update({
      where: { supplierId_productId: { supplierId, productId: product.id } },
      data,
      include: {
        supplier: { select: { id: true, name: true } },
        product: { select: { id: true, code: true, name: true } },
      },
    });

    res.json({
      message: "SupplierProduct diupdate.",
      data: { ...updated, costPrice: String(updated.costPrice) },
    });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Mapping supplier-produk tidak ditemukan." });
    console.error("patchSupplierProduct error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

/**
 * GET /api/admin/suppliers/:supplierId/products
 * Query: ?available=true|false&minPriority=1
 */
export async function listSupplierProducts(req, res) {
  try {
    const { supplierId } = req.params;
    const { available, minPriority } = req.query;

    const where = {
      supplierId,
      ...(available !== undefined && { isAvailable: available === "true" }),
      ...(minPriority !== undefined && { priority: { gte: Number(minPriority) } }),
    };

    const rows = await prisma.supplierProduct.findMany({
      where,
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
      include: {
        product: { select: { code: true, name: true, type: true, nominal: true } },
      },
    });

    res.json({
      data: rows.map(r => ({ ...r, costPrice: String(r.costPrice) })),
    });
  } catch (err) {
    console.error("listSupplierProducts error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

/**
 * POST /api/admin/suppliers/:supplierId/products/bulk
 * Body: { items: Array<{ productCode, supplierSku, costPrice, isAvailable?, priority? }> }
 * - Upsert per item
 */
export async function bulkUpsertSupplierProducts(req, res) {
  try {
    const { supplierId } = req.params;
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items wajib array minimal 1." });
    }

    const result = await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({
        where: { id: supplierId },
        select: { id: true, status: true },
      });
      if (!supplier || supplier.status !== "ACTIVE") throw new Error("SUPPLIER_INACTIVE");

      const out = [];
      for (const [i, it] of items.entries()) {
        const { productCode, supplierSku, costPrice, isAvailable, priority } = it || {};
        if (!productCode || !supplierSku || costPrice === undefined || costPrice === null || isNaN(Number(costPrice))) {
          throw new Error(`ITEM_INVALID_${i}`);
        }
        const prod = await tx.product.findUnique({
          where: { code: productCode },
          select: { id: true, isActive: true },
        });
        if (!prod || !prod.isActive) throw new Error(`PRODUCT_INACTIVE_${i}`);

        const row = await tx.supplierProduct.upsert({
          where: { supplierId_productId: { supplierId: supplier.id, productId: prod.id } },
          update: {
            supplierSku,
            costPrice: BigInt(String(costPrice)),
            ...(typeof isAvailable === "boolean" && { isAvailable }),
            ...(priority !== undefined && { priority: Number(priority) }),
          },
          create: {
            supplierId: supplier.id,
            productId: prod.id,
            supplierSku,
            costPrice: BigInt(String(costPrice)),
            isAvailable: typeof isAvailable === "boolean" ? isAvailable : true,
            priority: priority !== undefined ? Number(priority) : 100,
          },
          select: { supplierId: true, productId: true },
        });
        out.push(row);
      }
      return out;
    });

    res.json({ message: "Bulk upsert selesai.", count: result.length });
  } catch (err) {
    if (String(err.message).startsWith("ITEM_INVALID_")) {
      return res.status(400).json({ error: `Data item tidak valid pada index ${err.message.split("_").pop()}.` });
    }
    if (String(err.message).startsWith("PRODUCT_INACTIVE_")) {
      return res.status(404).json({ error: `Produk tidak aktif pada index ${err.message.split("_").pop()}.` });
    }
    if (err.message === "SUPPLIER_INACTIVE") {
      return res.status(404).json({ error: "Supplier tidak ditemukan/INACTIVE." });
    }
    console.error("bulkUpsertSupplierProducts error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
