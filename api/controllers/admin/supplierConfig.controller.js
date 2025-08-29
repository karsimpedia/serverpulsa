import prisma from '../../prisma.js';
import { invalidateSupplierConfigCache } from '../../lib/supplier-registry-db.js';
import { callSupplier } from '../../lib/supplier-client.js';
import { validateOps } from '../../../utils/supplierConfigValidator.js';
// Validasi sederhana struktur ops


// GET /admin/suppliers/:id/config
export async function getSupplierConfig(req, res) {
  try {
    const { id } = req.params;
    const sup = await prisma.supplier.findUnique({
      where: { id },
      select: { id: true, code: true, config: true }
    });
    if (!sup) return res.status(404).json({ error: 'Supplier tidak ditemukan' });
    return res.json({ ok: true, data: sup.config || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// PUT /admin/suppliers/:code/config
// body: { version?, defaults?, ops }
export async function upsertSupplierConfig(req, res) {
  try {
    const { id } = req.params;
    const { version = 1, defaults = {}, ops } = req.body || {};
    if (!ops) return res.status(400).json({ error: 'ops wajib' });

    validateOps(ops);

    const sup = await prisma.supplier.findUnique({ where: { id } });
    if (!sup) return res.status(404).json({ error: 'Supplier tidak ditemukan' });

    const data = await prisma.supplierConfig.upsert({
      where: { supplierId: sup.id },
      create: { supplierId: sup.id, version: Number(version), defaults, ops },
      update: { version: Number(version), defaults, ops }
    });

    // invalidateSupplierConfigCache(code);
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// PATCH /admin/suppliers/:code/config/ops/:op
// body: { method?, path?, headers?, body?, response? }
export async function patchSupplierOp(req, res) {
  try {
    const { code, op } = req.params;
    const allowedOps = ['topup', 'inquiry', 'paybill', 'callback'];
    if (!allowedOps.includes(op)) return res.status(400).json({ error: 'op tidak valid' });

    const sup = await prisma.supplier.findUnique({ where: { code }, include: { SupplierConfig: true } });
    if (!sup || !sup.SupplierConfig) return res.status(404).json({ error: 'Config belum ada' });

    const ops = sup.SupplierConfig.ops || {};
    const current = ops[op] || {};
    const merged = { ...current, ...(req.body || {}) };
    ops[op] = merged;

    const data = await prisma.supplierConfig.update({
      where: { supplierId: sup.id },
      data: { ops }
    });

    invalidateSupplierConfigCache(code);
    res.json({ ok: true, data: { op, value: data.ops[op] } });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// POST /admin/suppliers/:code/config/test
// body: { op, endpointId, ctx } -> coba panggil supplier dg config & endpoint tertentu



export async function testSupplierConfig(req, res) {
  try {
    const { code } = req.params;
    const { op, endpointId, ctx = {} } = req.body || {};
    if (!op) return res.status(400).json({ error: 'op wajib' });

    // Ambil endpoint
    const ep = endpointId
      ? await prisma.supplierEndpoint.findUnique({ where: { id: endpointId } })
      : await prisma.supplierEndpoint.findFirst({ where: { supplier: { code }, isActive: true } });

    if (!ep) return res.status(404).json({ error: 'Endpoint tidak ditemukan/aktif' });

    const callCtx = {
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      ...ctx
    };

    const r = await callSupplier(op, code, callCtx);
    res.json({ ok: true, result: r });
  } catch (e) { res.status(400).json({ error: e.message }); }
}
