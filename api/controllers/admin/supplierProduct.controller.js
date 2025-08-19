// api/controllers/admin/supplierProduct.controller.js
import prisma from '../../prisma.js';

// POST /admin/suppliers/:supplierId/products
export async function upsertSupplierProduct(req, res) {
  try {
    const { supplierId } = req.params;
    const { productId, supplierSku, costPrice, isAvailable = true, priority = 100 } = req.body;

    console.log(req.body)
    if (!productId || !supplierSku || costPrice == null) {
      return res.status(400).json({ error: 'productId, supplierSku, costPrice wajib' });
    }
    const data = await prisma.supplierProduct.upsert({
      where: { supplierId_productId: { supplierId, productId } },
      create: { supplierId, productId, supplierSku, costPrice: BigInt(costPrice), isAvailable, priority },
      update: { supplierSku, costPrice: BigInt(costPrice), isAvailable, priority },
    });
    res.json({ ok: true, data });
  } catch (e) { 
    console.log(e)
    res.status(400).json({ error: e.message }); }
}

// PATCH /admin/supplier-products/:id
export async function updateSupplierProduct(req, res) {
  try {
    const { id } = req.params;
    const { supplierSku, costPrice, isAvailable, priority } = req.body;
    const data = await prisma.supplierProduct.update({
      where: { id },
      data: {
        ...(supplierSku && { supplierSku }),
        ...(costPrice != null && { costPrice: BigInt(costPrice) }),
        ...(isAvailable != null && { isAvailable: !!isAvailable }),
        ...(priority != null && { priority: Number(priority) }),
      },
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// POST /admin/supplier-products/:id/toggle
export async function toggleSupplierProduct(req, res) {
  try {
    const { id } = req.params;
    const { isAvailable } = req.body;
    const data = await prisma.supplierProduct.update({
      where: { id }, data: { isAvailable: !!isAvailable },
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// POST /admin/supplier-products/bulk
export async function bulkUpsertSupplierProducts(req, res) {
  try {
    const { rows } = req.body; // [{supplierId, productId, supplierSku, costPrice, isAvailable?, priority?}, ...]
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'rows kosong' });
    }
    const ops = rows.map(r =>
      prisma.supplierProduct.upsert({
        where: { supplierId_productId: { supplierId: r.supplierId, productId: r.productId } },
        create: {
          supplierId: r.supplierId,
          productId: r.productId,
          supplierSku: r.supplierSku,
          costPrice: BigInt(r.costPrice),
          isAvailable: r.isAvailable ?? true,
          priority: r.priority ?? 100
        },
        update: {
          supplierSku: r.supplierSku,
          costPrice: BigInt(r.costPrice),
          isAvailable: r.isAvailable ?? true,
          priority: r.priority ?? 100
        }
      })
    );
    const data = await prisma.$transaction(ops);
    res.json({ ok: true, count: data.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
}
