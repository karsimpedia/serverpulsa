import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// POST /api/category  { name, code? }



export async function bulkMoveProducts(req, res) {
  try {
    const targetIdRaw = req.params.id;
    const targetId = targetIdRaw === "null" ? null : targetIdRaw;

    const {
      productIds,
      productCodes,
      sourceCategoryId,
      q,
      type,
      active,
      prefix,
    } = req.body || {};

    // Validasi target category jika bukan null
    if (targetId) {
      const target = await prisma.productCategory.findUnique({
        where: { id: targetId },
        select: { id: true },
      });
      if (!target) return res.status(404).json({ error: "Kategori target tidak ditemukan." });
    }

    // Bangun where dinamika untuk pemilihan produk
    let where = {};
    let selectMode = "";

    if (Array.isArray(productIds) && productIds.length) {
      selectMode = "ids";
      where = { id: { in: productIds } };
    } else if (Array.isArray(productCodes) && productCodes.length) {
      selectMode = "codes";
      where = { code: { in: productCodes.map((c) => String(c).trim().toUpperCase()) } };
    } else {
      // Mode filter dari kategori sumber
      selectMode = "filter";
      where = {
        ...(sourceCategoryId ? { categoryId: sourceCategoryId } : {}),
        ...(q
          ? {
              OR: [
                { code: { contains: q, mode: "insensitive" } },
                { name: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(type && (type === "PULSA" || type === "TAGIHAN") ? { type } : {}),
        ...(typeof active === "boolean" ? { isActive: active } : {}),
        ...(prefix ? { code: { startsWith: String(prefix).toUpperCase() } } : {}),
      };
    }

    // Ambil kandidat dulu biar dapat count & preview
    const candidates = await prisma.product.findMany({
      where,
      select: { id: true, code: true, categoryId: true },
    });

    if (candidates.length === 0) {
      return res.status(400).json({ error: "Tidak ada produk yang cocok untuk dipindahkan." });
    }

    // Eksekusi dalam transaksi
    const result = await prisma.$transaction(async (tx) => {
      // Pindahkan
      const upd = await tx.product.updateMany({
        where: { id: { in: candidates.map((x) => x.id) } },
        data: { categoryId: targetId },
      });

      // Info tambahan: hitung per asal kategori
      let affectedBySource = undefined;
      if (sourceCategoryId) {
        const remain = await tx.product.count({ where: { categoryId: sourceCategoryId } });
        affectedBySource = { sourceCategoryId, remaining: remain };
      }

      return { updatedCount: upd.count, affectedBySource };
    });

    return res.json({
      message: "Produk dipindahkan.",
      movedTo: targetId ?? null,
      selectedBy: selectMode,
      selectedCount: candidates.length,
      updatedCount: result.updatedCount,
      ...(result.affectedBySource ? { affectedBySource: result.affectedBySource } : {}),
      sample: candidates.slice(0, 10), // sampel maksimal 10
    });
  } catch (e) {
    console.error("bulkMoveProducts:", e);
    return res.status(500).json({ error: "Gagal memindahkan produk." });
  }
}



export async function upsertCategory(req, res) {
  try {
    let { name, code, description } = req.body || {};
    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: "Kode kategori wajib diisi." });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Nama kategori wajib diisi." });
    }

    // Normalisasi
    const norm = (v) => (v == null ? null : String(v).trim());
    // kalau tidak pakai citext, paksa uppercase agar konsisten
    code = norm(code).toUpperCase();
    name = norm(name).toUpperCase();
    description = norm(description);

    const category = await prisma.productCategory.upsert({
      where: { code },                 // ← kunci uniknya di sini
      update: { name, description },
      create: { code, name, description },
    });

    return res.status(200).json({ data: category });
  } catch (e) {
    if (e.code === "P2002" && e.meta?.target?.includes("code")) {
      return res.status(409).json({ error: "Kode kategori sudah digunakan." });
    }
    console.error("upsertCategory:", e);
    return res.status(500).json({ error: "Gagal upsert kategori." });
  }
}

// GET /api/category?page=&limit=
export async function listCategories(req, res) {
  try {
    const page  = Math.max(parseInt(req.query.page ?? "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? "20"), 1), 100);
    const skip  = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.productCategory.findMany({
        skip, take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { products: true } }, // hitung jumlah produk
        },
      }),
      prisma.productCategory.count(),
    ]);

    res.json({
      data: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    console.error("listCategories:", e);
    res.status(500).json({ error: "Gagal mengambil kategori." });
  }
}

// GET /api/category/:id
export async function getCategoryById(req, res) {
  try {
    const { id } = req.params;
    const cat = await prisma.productCategory.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!cat) return res.status(404).json({ error: "Kategori tidak ditemukan." });
    res.json({ data: cat });
  } catch (e) {
    console.error("getCategoryById:", e);
    res.status(500).json({ error: "Gagal mengambil kategori." });
  }
}

// GET /api/category/:id/products?type=&active=&page=&limit=&q=
export async function getCategoryProducts(req, res) {
  try {
    const { id }    = req.params;
    const q         = (req.query.q ?? "").toString().trim();
    const type      = (req.query.type ?? "").toString().toUpperCase(); // PULSA/TAGIHAN
    const activeQ   = req.query.active; // "true"/"false"
    const page      = Math.max(parseInt(req.query.page ?? "1"), 1);
    const limit     = Math.min(Math.max(parseInt(req.query.limit ?? "20"), 1), 100);
    const skip      = (page - 1) * limit;

    // pastikan kategori ada
    const cat = await prisma.productCategory.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!cat) return res.status(404).json({ error: "Kategori tidak ditemukan." });

    const where = {
      categoryId: id,
      ...(q ? { OR: [
        { code: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ] } : {}),
      ...(type && (type === "PULSA" || type === "TAGIHAN") ? { type } : {}),
      ...(typeof activeQ !== "undefined" ? { isActive: activeQ === "true" } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip, take: limit,
        orderBy: [{ isActive: "desc" }, { code: "asc" }],
      }),
      prisma.product.count({ where }),
    ]);

    res.json({
      category: cat,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    console.error("getCategoryProducts:", e);
    res.status(500).json({ error: "Gagal mengambil produk kategori." });
  }
}

// DELETE /api/category/:id
export async function deleteCategory(req, res) {
  try {
    const { id } = req.params;
    const inUse = await prisma.product.count({ where: { categoryId: id } });
    if (inUse > 0) {
      return res.status(409).json({ error: "Kategori dipakai oleh produk. Pindahkan/hapus produk terlebih dahulu." });
    }
    await prisma.productCategory.delete({ where: { id } });
    res.json({ message: "Kategori dihapus." });
  } catch (e) {
    console.error("deleteCategory:", e);
    res.status(500).json({ error: "Gagal menghapus kategori." });
  }
}
