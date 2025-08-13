// api/controllers/admin/supplier.controller.js
import prisma from '../../prisma.js';

// POST /admin/suppliers
export async function createSupplier(req, res) {
  try {
    const { name, code, status = 'ACTIVE' } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'name & code wajib' });
    const data = await prisma.supplier.create({ data: { name, code, status } });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// PATCH /admin/suppliers/:id
export async function updateSupplier(req, res) {
  try {
    const { id } = req.params;
    const { name, code, status } = req.body;
    const data = await prisma.supplier.update({
      where: { id },
      data: { ...(name && { name }), ...(code && { code }), ...(status && { status }) },
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// GET /admin/suppliers
export async function listSuppliers(req, res) {
  try {
    const { search = '', status } = req.query;
    const data = await prisma.supplier.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: search ? [{ name: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }] : undefined,
      },
      include: { endpoints: true, products: true },
      orderBy: [{ name: 'asc' }],
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}
