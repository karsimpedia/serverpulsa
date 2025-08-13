// api/controllers/admin/supplierEndpoint.controller.js
import prisma from '../../prisma.js';

// POST /admin/suppliers/:supplierId/endpoints
export async function createEndpoint(req, res) {
  try {
    const { supplierId } = req.params;
    const { name, baseUrl, apiKey, secret, isActive = true } = req.body;
    if (!name || !baseUrl) return res.status(400).json({ error: 'name & baseUrl wajib' });
    const data = await prisma.supplierEndpoint.create({
      data: { supplierId, name, baseUrl, apiKey, secret, isActive },
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// PATCH /admin/suppliers/:supplierId/endpoints/:id
export async function updateEndpoint(req, res) {
  try {
    const { id } = req.params;
    const { name, baseUrl, apiKey, secret, isActive } = req.body;
    const data = await prisma.supplierEndpoint.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(baseUrl && { baseUrl }),
        ...(apiKey !== undefined && { apiKey }),
        ...(secret !== undefined && { secret }),
        ...(isActive !== undefined && { isActive }),
      },
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// POST /admin/suppliers/:supplierId/endpoints/:id/toggle
export async function toggleEndpoint(req, res) {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    const data = await prisma.supplierEndpoint.update({
      where: { id }, data: { isActive: !!isActive },
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}

// POST /admin/suppliers/:supplierId/endpoints/:id/rotate-key
export async function rotateEndpointKey(req, res) {
  try {
    const { id } = req.params;
    const { apiKey, secret } = req.body; // atau generate di server
    const data = await prisma.supplierEndpoint.update({
      where: { id }, data: { ...(apiKey && { apiKey }), ...(secret && { secret }) },
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
}
