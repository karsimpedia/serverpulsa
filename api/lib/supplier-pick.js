// api/lib/supplier-pick.js
import prisma from '../prisma.js';

export async function pickSupplierForProduct(productId) {
  const sp = await prisma.supplierProduct.findFirst({
    where: {
      productId,
      isAvailable: true,
      supplier: { status: 'ACTIVE' },
      supplier: { endpoints: { some: { isActive: true } } }
    },
    orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }],
    include: { supplier: { include: { endpoints: { where: { isActive: true } } } }, product: true }
  });
  if (!sp || sp.supplier.endpoints.length === 0) return null;
  const endpoint = sp.supplier.endpoints[0];
  return { supplier: sp.supplier, endpoint, supplierProduct: sp };
}
