const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const queue = require("../worker/queue");

const api = {};

api.topup = async (req, res) => {
  try {
    const { resellerId, productCode, phone, deviceType, deviceId } = req.body;

    if (!resellerId || !productCode || !phone || !deviceType || !deviceId) {
      return res.status(400).json({ error: "Data tidak lengkap. resellerId, productCode, phone, deviceType, dan deviceId wajib diisi." });
    }

    // Validasi device terdaftar
    const isAllowed = await prisma.resellerDevice.findFirst({
      where: {
        resellerId,
        type: deviceType,
        identifier: deviceId,
      },
    });

    if (!isAllowed) {
      return res.status(403).json({ error: "Device tidak diizinkan untuk melakukan transaksi." });
    }

    const product = await prisma.product.findUnique({
      where: { code: productCode },
    });
    if (!product || !product.isActive) {
      return res.status(404).json({ error: "Produk tidak ditemukan atau tidak aktif." });
    }

    const harga = await prisma.hargaJual.findUnique({
      where: {
        resellerId_productId: {
          resellerId,
          productId: product.id,
        },
      },
    });
    if (!harga) {
      return res.status(404).json({ error: "Harga jual tidak ditemukan untuk reseller ini." });
    }

    const supplierProduct = await prisma.supplierProduct.findFirst({
      where: {
        productId: product.id,
        isPrimary: true,
      },
      include: {
        supplier: true,
      },
    });
    if (!supplierProduct) {
      return res.status(404).json({ error: "Produk tidak tersedia di supplier." });
    }

    const reseller = await prisma.reseller.findUnique({
      where: { id: resellerId },
    });
    if (!reseller) {
      return res.status(404).json({ error: "Reseller tidak ditemukan." });
    }

    if (reseller.saldo < harga.price) {
      return res.status(400).json({ error: "Saldo tidak mencukupi." });
    }

    const trx = await prisma.topup.create({
      data: {
        phone,
        productId: product.id,
        resellerId,
        price: harga.price,
        status: "pending",
      },
    });

    await prisma.mutasiSaldo.create({
      data: {
        resellerId,
        amount: -harga.price,
        type: "topup",
        note: `Topup ke ${phone}`,
        relatedTo: trx.id,
      },
    });

    await prisma.reseller.update({
      where: { id: resellerId },
      data: {
        saldo: {
          decrement: harga.price,
        },
      },
    });

    await queue.add("send-topup", {
      topupId: trx.id,
      phone,
      kodeProduk: supplierProduct.kodeSupplier,
      supplier: {
        url: supplierProduct.supplier.apiUrl,
        apiKey: supplierProduct.supplier.apiKey,
      },
    });

    return res.json({
      status: "pending",
      topupId: trx.id,
      message: "Transaksi sedang diproses.",
    });
  } catch (err) {
    console.error("Topup error:", err);
    res.status(500).json({ error: "Terjadi kesalahan internal saat memproses topup." });
  }
};

module.exports = api;
