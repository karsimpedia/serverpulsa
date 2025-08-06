const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Seeding data...");

  // 1. Supplier
  const tripay = await prisma.supplier.upsert({
    where: { name: 'tripay' },
    update: {},
    create: { name: 'tripay', active: true },
  });

  const digiflazz = await prisma.supplier.upsert({
    where: { name: 'digiflazz' },
    update: {},
    create: { name: 'digiflazz', active: true },
  });

  // 2. Produk
  const xl1 = await prisma.product.upsert({
    where: { kodeProduk: 'XL1' },
    update: {},
    create: {
      kodeProduk: 'XL1',
      nominal: 1000,
      harga: 1300,
      margin: 300,
      status: true,
      jenis: 'pulsa',
    },
  });

  const xl5 = await prisma.product.upsert({
    where: { kodeProduk: 'XL5' },
    update: {},
    create: {
      kodeProduk: 'XL5',
      nominal: 5000,
      harga: 5300,
      margin: 300,
      status: true,
      jenis: 'pulsa',
    },
  });

  const pln50 = await prisma.product.upsert({
    where: { kodeProduk: 'PLN50' },
    update: {},
    create: {
      kodeProduk: 'PLN50',
      nominal: 50000,
      harga: 51000,
      margin: 1000,
      status: true,
      jenis: 'tagihan',
    },
  });

  // 3. Supplier-Product mapping
  await prisma.supplierProduct.createMany({
    data: [
      {
        supplierId: tripay.id,
        productId: xl1.id,
        status: true,
        priority: 1,
      },
      {
        supplierId: digiflazz.id,
        productId: xl1.id,
        status: true,
        priority: 2,
      },
      {
        supplierId: tripay.id,
        productId: xl5.id,
        status: true,
        priority: 1,
      },
      {
        supplierId: digiflazz.id,
        productId: pln50.id,
        status: true,
        priority: 1,
      },
    ],
    skipDuplicates: true,
  });

  console.log("✅ Seeder selesai.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
