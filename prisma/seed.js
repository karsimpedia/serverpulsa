// prisma/seed.js
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

/* ===== Helpers Supplier / Endpoint / Mapping ===== */
async function upsertSupplier(prisma, { code, name, status = "ACTIVE" }) {
  return prisma.supplier.upsert({
    where: { code },             // code unik
    update: { name, status },
    create: { code, name, status },
  });
}

async function ensureEndpoint(prisma, { supplierId, name, baseUrl, apiKey = null, secret = null, isActive = true }) {
  const existing = await prisma.supplierEndpoint.findFirst({ where: { supplierId, name } });
  if (existing) {
    return prisma.supplierEndpoint.update({
      where: { id: existing.id },
      data: { baseUrl, apiKey, secret, isActive },
    });
  }
  return prisma.supplierEndpoint.create({
    data: { supplierId, name, baseUrl, apiKey, secret, isActive },
  });
}

async function upsertSupplierProduct(prisma, {
  supplierCode, productCode, supplierSku, costPrice, isAvailable = true, priority = 100
}) {
  const [supplier, product] = await Promise.all([
    prisma.supplier.findUnique({ where: { code: supplierCode }, select: { id: true } }),
    prisma.product.findUnique({ where: { code: productCode }, select: { id: true } }),
  ]);
  if (!supplier) throw new Error(`Supplier code=${supplierCode} tidak ditemukan`);
  if (!product)  throw new Error(`Product code=${productCode} tidak ditemukan`);

  return prisma.supplierProduct.upsert({
    where: { supplierId_productId: { supplierId: supplier.id, productId: product.id } }, // @@unique([supplierId, productId])
    update: { supplierSku, costPrice: BigInt(costPrice), isAvailable, priority },
    create: { supplierId: supplier.id, productId: product.id, supplierSku, costPrice: BigInt(costPrice), isAvailable, priority },
  });
}

/* ===== Seed utama ===== */
async function main() {
  console.log("🚀 Starting seed...");

  // Bersihkan DB (urut sesuai FK)
  await prisma.supplierProduct.deleteMany();
  await prisma.supplierEndpoint.deleteMany();
  await prisma.transactionCommission?.deleteMany().catch(()=>{});
  await prisma.transaction?.deleteMany().catch(()=>{});

  await prisma.device.deleteMany();
  await prisma.saldo.deleteMany();
  await prisma.reseller.deleteMany();

  await prisma.product.deleteMany();
  await prisma.productCategory.deleteMany();

  await prisma.user.deleteMany();
  await prisma.supplier.deleteMany();

  // Kategori (tanpa description)
  const catPulsaXL = await prisma.productCategory.upsert({
    where: { name: "PULSA REGULER XL" }, // pastikan name unik di schema
    update: {},
    create: { name: "PULSA REGULER XL" },
  });
  const catPulsaSimpati = await prisma.productCategory.upsert({
    where: { name: "PULSA REGULER SIMPATI" },
    update: {},
    create: { name: "PULSA REGULER SIMPATI" },
  });

  // Produk (BigInt!)
  const prodXL5 = await prisma.product.upsert({
    where: { code: "XL5" },
    update: {
      name: "Pulsa XL 5K",
      type: "PULSA",
      nominal: 5000,
      basePrice: 4800n,
      margin: 200n,
      isActive: true,
      categoryId: catPulsaXL.id,
    },
    create: {
      code: "XL5",
      name: "Pulsa XL 5K",
      type: "PULSA",
      nominal: 5000,
      basePrice: 4800n,
      margin: 200n,
      isActive: true,
      categoryId: catPulsaXL.id,
    },
  });

  const prodTSEL10 = await prisma.product.upsert({
    where: { code: "TSEL10" },            // konsisten dengan mapping supplier nanti
    update: {
      name: "Pulsa Telkomsel 10K",
      type: "PULSA",
      nominal: 10000,
      basePrice: 10050n,
      margin: 500n,
      isActive: true,
      categoryId: catPulsaSimpati.id,
    },
    create: {
      code: "TSEL10",
      name: "Pulsa Telkomsel 10K",
      type: "PULSA",
      nominal: 10000,
      basePrice: 10050n,
      margin: 500n,
      isActive: true,
      categoryId: catPulsaSimpati.id,
    },
  });

  // Suppliers
  const supXL   = await upsertSupplier(prisma, { code: "SUP-XL",   name: "Supplier XL" });
  const supTSEL = await upsertSupplier(prisma, { code: "SUP-TSEL", name: "Supplier Telkomsel" });

  // Endpoints
  await ensureEndpoint(prisma, {
    supplierId: supXL.id,
    name: "PRIMARY",
    baseUrl: "https://dummy-supplier-xl.com/api",
    apiKey: "apikey-xl",
    secret: null,
    isActive: true,
  });
  await ensureEndpoint(prisma, {
    supplierId: supTSEL.id,
    name: "PRIMARY",
    baseUrl: "https://dummy-supplier-telkomsel.com/api",
    apiKey: "apikey-telkomsel",
    secret: null,
    isActive: true,
  });

  // Mapping produk -> supplier (harga modal pemasok)
  await upsertSupplierProduct(prisma, {
    supplierCode: "SUP-XL",
    productCode: "XL5",
    supplierSku: "XL-5K",
    costPrice: 4800n,
    priority: 50,
  });
  await upsertSupplierProduct(prisma, {
    supplierCode: "SUP-TSEL",
    productCode: "TSEL10",
    supplierSku: "TSEL-10K",
    costPrice: 10050n,
    priority: 50,
  });

  // User & Reseller (saldo 50.000)
  const hashedPass = await bcrypt.hash("123456", 10);
  const hashedPin  = await bcrypt.hash("123456", 10);

  const userReseller = await prisma.user.upsert({
    where: { username: "reseller1" },
    update: { password: hashedPass, role: "RESELLER" },
    create: { username: "reseller1", password: hashedPass, role: "RESELLER" },
  });

  // Pastikan tidak tabrakan id/unique
  await prisma.reseller.deleteMany({ where: { OR: [{ userId: userReseller.id }, { id: "LA0003" }] } });

  const reseller = await prisma.reseller.create({
    data: {
      id: "LA0003",
      userId: userReseller.id,
      name: "Reseller Demo",
      apiKeyHash: "",
      isActive: true,
      referralCode: "LA0003", // samakan dengan id agar unik aman
      pin: hashedPin,
    },
  });

  await prisma.saldo.upsert({
    where: { resellerId: reseller.id },
    update: { amount: 50000n },
    create: { resellerId: reseller.id, amount: 50000n },
  });

  await prisma.device.upsert({
    where: { identifier: "081234567890" }, // asumsikan identifier unik
    update: { resellerId: reseller.id, isActive: true },
    create: { resellerId: reseller.id, type: "PHONE", identifier: "081234567890", isActive: true },
  });

  console.log("✅ Seed selesai!");
}

main()
  .catch((e) => {
    console.error("❌ Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
