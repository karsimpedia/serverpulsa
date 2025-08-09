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
    let { code, name, type, nominal, basePrice, margin, isActive } = req.body;

    if (!code || !name || !type || basePrice == null) {
      return res.status(400).json({ error: "Field wajib: code,name,type,basePrice" });
    }

    // Normalisasi code: trim + uppercase
    code = String(code).trim().toUpperCase();

    // Validasi enum ProductType
    const allowedTypes = ["PULSA", "TAGIHAN"];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: "type harus PULSA atau TAGIHAN" });
    }

    // (Opsional) Cek cepat sebelum insert
    const existed = await prisma.product.findUnique({ where: { code } });
    if (existed) {
      return res.status(409).json({ error: "Kode produk sudah terpakai." });
    }

    const prod = await prisma.product.create({
      data: {
        code,
        name,
        type,
        nominal: nominal ?? null,
        basePrice: BigInt(basePrice),
        margin: BigInt(margin ?? 0),
        isActive: isActive ?? true,
      },
    });

    return res.status(201).json({ data: toPlainProduct(prod) });
  } catch (e) {
    // Tangkap unique constraint dari Prisma (double safety)
    if (e.code === "P2002" && e.meta?.target?.includes("code")) {
      return res.status(409).json({ error: "Kode produk sudah terpakai." });
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
export async function getAllProducts(_req, res) {
  try {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: "desc" },
    });
    return res.json({ data: toPlainProducts(products) });
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
