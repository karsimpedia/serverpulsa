// api/controllers/supplierProductCategory.js
import prisma from "../prisma.js";

/**
 * POST /api/admin/suppliers/:supplierId/categories/:categoryId/upsert-products
 * Body:
 * {
 *   costMode: "COPY_BASE" | "PERCENT" | "ADD",
 *   percent?: number,      // untuk PERCENT, contoh 2.5 artinya +2.5%
 *   addAmount?: string|number, // untuk ADD, contoh "500"
 *   defaultAvailable?: boolean, // default true
 *   defaultPriority?: number,   // default 100
 *   dryRun?: boolean,           // jika true hanya simulasi
 *   overrides?: Array<{
 *     productCode: string,
 *     supplierSku?: string,
 *     costPrice?: string|number,
 *     isAvailable?: boolean,
 *     priority?: number
 *   }>
 * }
 */
export async function upsertSupplierProductsByCategory(req, res) {
  try {
    const { supplierId, categoryId } = req.params;
    const {
      costMode = "COPY_BASE",
      percent,
      addAmount,
      defaultAvailable = true,
      defaultPriority = 100,
      dryRun = false,
      overrides = [],
    } = req.body || {};

    // Validasi supplier
    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, status: true },
    });
    if (!supplier || supplier.status !== "ACTIVE") {
      return res.status(404).json({ error: "Supplier tidak ditemukan/INACTIVE." });
    }

    // Ambil semua produk aktif di kategori
    const products = await prisma.product.findMany({
      where: { categoryId, isActive: true },
      select: { id: true, code: true, basePrice: true },
    });
    if (products.length === 0) {
      return res.status(404).json({ error: "Tidak ada produk aktif pada kategori ini." });
    }

    // Siapkan map override per code
    const overrideMap = new Map();
    for (const ov of Array.isArray(overrides) ? overrides : []) {
      if (ov?.productCode) overrideMap.set(ov.productCode, ov);
    }

    // Helper hitung cost
    const addAmountBN = addAmount !== undefined && addAmount !== null ? BigInt(String(addAmount)) : null;
    const percentNum = percent !== undefined && percent !== null ? Number(percent) : null;

    function calcCost(basePrice, code) {
      const ov = overrideMap.get(code);
      if (ov?.costPrice !== undefined && ov?.costPrice !== null) {
        return BigInt(String(ov.costPrice));
      }
      if (costMode === "PERCENT") {
        if (typeof percentNum !== "number" || Number.isNaN(percentNum)) {
          throw new Error("PERCENT_INVALID");
        }
        // basePrice BigInt → konversi ke number untuk kalkulasi, lalu bulatkan ke BigInt
        const bp = Number(basePrice);
        const result = Math.round(bp * (1 + percentNum / 100));
        return BigInt(result);
      }
      if (costMode === "ADD") {
        if (addAmountBN === null) throw new Error("ADD_INVALID");
        return basePrice + addAmountBN;
      }
      // COPY_BASE
      return basePrice;
    }

    // Dry run preview
    if (dryRun) {
      const preview = products.map(p => {
        const ov = overrideMap.get(p.code);
        const cost = String(calcCost(BigInt(String(p.basePrice)), p.code));
        return {
          productCode: p.code,
          supplierSku: ov?.supplierSku ?? p.code, // default pakai code internal
          costPrice: cost,
          isAvailable: typeof ov?.isAvailable === "boolean" ? ov.isAvailable : defaultAvailable,
          priority: ov?.priority !== undefined ? Number(ov.priority) : Number(defaultPriority),
        };
      });
      return res.json({ dryRun: true, supplierId, categoryId, count: preview.length, items: preview });
    }

    // Eksekusi upsert per item di dalam transaksi
    const result = await prisma.$transaction(async (tx) => {
      let created = 0;
      let updated = 0;

      for (const p of products) {
        const ov = overrideMap.get(p.code);

        const costPrice = calcCost(BigInt(String(p.basePrice)), p.code);
        const supplierSku = ov?.supplierSku ?? p.code; // default: gunakan code internal
        const isAvailable = typeof ov?.isAvailable === "boolean" ? ov.isAvailable : defaultAvailable;
        const priority = ov?.priority !== undefined ? Number(ov.priority) : Number(defaultPriority);

        // pastikan product masih ada/aktif (opsional recheck)
        // upsert mapping
        const previous = await tx.supplierProduct.findUnique({
          where: { supplierId_productId: { supplierId: supplier.id, productId: p.id } },
          select: { id: true },
        });

        await tx.supplierProduct.upsert({
          where: { supplierId_productId: { supplierId: supplier.id, productId: p.id } },
          update: {
            supplierSku,
            costPrice,
            isAvailable,
            priority,
            // updatedAt otomatis
          },
          create: {
            supplierId: supplier.id,
            productId: p.id,
            supplierSku,
            costPrice,
            isAvailable,
            priority,
          },
        });

        if (previous) updated++;
        else created++;
      }

      return { created, updated, total: products.length };
    });

    return res.json({
      message: "Upsert kategori → supplier selesai.",
      ...result,
      supplierId,
      categoryId,
    });
  } catch (err) {
    if (err.message === "PERCENT_INVALID") {
      return res.status(400).json({ error: "percent wajib angka untuk costMode=PERCENT." });
    }
    if (err.message === "ADD_INVALID") {
      return res.status(400).json({ error: "addAmount wajib untuk costMode=ADD." });
    }
    console.error("upsertSupplierProductsByCategory error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
