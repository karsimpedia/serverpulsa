// FILE: prisma/seed.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  await prisma.reseller.upsert({
    where: { id: "res1" },
    update: {},
    create: {
      id: "res1",
      username: "reseller1", 
      name: "Reseller Satu",
      saldo: 20000,
      password: "rahasia"
    },
  });

  await prisma.product.upsert({
    where: { id: "prod1" },
    update: {},
    create: {
      id: "prod1",
      name: "Pulsa XL 10k",
      nominal: 10000,
      code: "XL10",
      type: "elektrik",
      isActive: true,
      basePrice: 100

    },
  });

  await prisma.hargaJual.upsert({
    where: { resellerId_productId: { resellerId: "res1", productId: "prod1" } },
    update: {},
    create: {
      resellerId: "res1",
      productId: "prod1",
      price: 9500,
    },
  });

  await prisma.supplier.upsert({
    where: { id: "sup1" },
    update: {},
    create: {
      id: "sup1",
      name: "MockSupplier",
      apiUrl: "http://mock_supplier:5001/topup",
      apiKey: "123456",
    },
  });

  await prisma.supplierProduct.upsert({
    where: { productId_supplierId: { productId: "prod1", supplierId: "sup1" } },
    update: {},
    create: {
      productId: "prod1",
      supplierId: "sup1",
      kodeSupplier: "XL10",
      isPrimary: true,
    },
  });

  console.log("✅ Data seed selesai");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

