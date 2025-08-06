
const Product = {}
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

Product.Addproduct= async (req, res) => {
  try {
    const { code, name, type, nominal, basePrice, isActive } = req.body;

    if (!code || !name || !type || nominal == null || basePrice == null) {
      return res.status(400).json({ error: "Semua field wajib diisi." });
    }

    const existing = await prisma.product.findUnique({ where: { code } });
    if (existing) {
      return res.status(400).json({ error: "Kode produk sudah digunakan." });
    }

    const product = await prisma.product.create({
      data: {
        code,
        name,
        type,
        nominal,
        basePrice,
        isActive: isActive ?? true,
      },
    });

    res.json({ message: "Produk berhasil ditambahkan", product });
  } catch (err) {
    console.error("Tambah produk gagal:", err);
    res.status(500).json({ error: "Terjadi kesalahan pada server." });
  }
};

module.exports = Product;
