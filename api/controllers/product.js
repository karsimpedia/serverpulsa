// api/controllers/product.js
import prisma from "../prisma.js";


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
