/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Users
  const adminPass = await bcrypt.hash('admin123', 10);
  const resPass   = await bcrypt.hash('reseller123', 10);

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: { username: 'admin', password: adminPass, role: 'ADMIN' },
  });

  const ures = await prisma.user.upsert({
    where: { username: 'reseller1' },
    update: {},
    create: { username: 'reseller1', password: resPass, role: 'RESELLER' },
  });

  // Reseller + Saldo
  const reseller = await prisma.reseller.upsert({
    where: { userId: ures.id },
    update: {},
    create: {
      userId: ures.id,
      name: 'Reseller One',
      apiKeyHash: await bcrypt.hash('RS-API-KEY-RESELLER1', 10),
      saldo: { create: { amount: 5_000_000n } },
    },
    include: { saldo: true },
  });

const plan = await prisma.commissionPlan.upsert({
  where: { name: 'Default Plan' },
  update: {},
  create: {
    name: 'Default Plan',
    base: 'MARGIN',   // komisi % berdasarkan margin
    maxLevels: 3,
    isActive: true
  }
});
// level rules: L1=50%, L2=30%, L3=20% dari margin (contoh ekstrem)
await prisma.commissionRule.createMany({
  data: [
    { planId: plan.id, level: 1, valueType: 'PERCENT', value: 50n },
    { planId: plan.id, level: 2, valueType: 'PERCENT', value: 30n },
    { planId: plan.id, level: 3, valueType: 'PERCENT', value: 20n },
  ],
  skipDuplicates: true
});

// assign ke semua reseller default
await prisma.commissionPlanAssignment.upsert({
  where: { resellerId: reseller.id }, // reseller dari seed kamu
  update: { planId: plan.id },
  create: { resellerId: reseller.id, planId: plan.id }
});


  // Supplier + Endpoint
  const supXL = await prisma.supplier.upsert({
    where: { code: 'XL' },
    update: {},
    create: { name: 'Supplier XL', code: 'XL', status: 'ACTIVE' },
  });

  await prisma.supplierEndpoint.createMany({
    data: [
      { supplierId: supXL.id, name: 'default', baseUrl: 'https://api.supplierxl.test', apiKey: 'XL-KEY', secret: 'XL-SECRET' },
    ],
    skipDuplicates: true,
  });

  // Produk
  const pr5 = await prisma.product.upsert({
    where: { code: 'XL5' },
    update: {},
    create: { code: 'XL5', name: 'XL 5K', type: 'PULSA', nominal: 5000, basePrice: 5200n, margin: 300n, isActive: true },
  });

  const pr10 = await prisma.product.upsert({
    where: { code: 'XL10' },
    update: {},
    create: { code: 'XL10', name: 'XL 10K', type: 'PULSA', nominal: 10000, basePrice: 10200n, margin: 500n, isActive: true },
  });

  await prisma.supplierProduct.upsert({
    where: { supplierId_productId: { supplierId: supXL.id, productId: pr5.id } },
    update: { costPrice: 5100n, isAvailable: true, priority: 10 },
    create: { supplierId: supXL.id, productId: pr5.id, supplierSku: 'XL-5', costPrice: 5100n, isAvailable: true, priority: 10 },
  });

  await prisma.supplierProduct.upsert({
    where: { supplierId_productId: { supplierId: supXL.id, productId: pr10.id } },
    update: { costPrice: 10050n, isAvailable: true, priority: 10 },
    create: { supplierId: supXL.id, productId: pr10.id, supplierSku: 'XL-10', costPrice: 10050n, isAvailable: true, priority: 10 },
  });

  // Callback default reseller
  await prisma.resellerCallback.create({
    data: { resellerId: reseller.id, url: 'https://reseller1.test/callback', secret: 'CB-SECRET' },
  });

  console.log('✅ Seed selesai');
}

main().then(() => prisma.$disconnect())
.catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
