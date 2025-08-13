// api/controllers/internal/healthcheck.controller.js
import prisma from '../../prisma.js';
import axios from 'axios';

function now() { return new Date(); }

// POST /internal/healthcheck/suppliers
// body: { path?: "/health" | "/ping" }
export async function healthCheckSuppliers(req, res) {
  const { path = '/health' } = req.body || {};
  const eps = await prisma.supplierEndpoint.findMany({ where: { isActive: true } });

  const results = await Promise.all(eps.map(async (ep) => {
    const url = `${ep.baseUrl.replace(/\/+$/, '')}${path}`;
    const start = Date.now();
    try {
      const { status } = await axios.get(url, { timeout: 5000, headers: ep.apiKey ? { 'x-api-key': ep.apiKey } : {} });
      const latency = Date.now() - start;
      const ok = status >= 200 && status < 400;

      await prisma.supplierEndpoint.update({
        where: { id: ep.id },
        data: {
          lastHealthAt: now(),
          lastStatus: ok ? 'UP' : 'DEGRADED',
          lastLatencyMs: latency,
          successCount: { increment: ok ? 1 : 0 },
          failCount: { increment: ok ? 0 : 1 },
        }
      });
      await prisma.supplierHealthLog.create({
        data: { endpointId: ep.id, status: ok ? 'UP' : 'DEGRADED', latencyMs: latency, message: ok ? null : `HTTP ${status}` }
      });

      return { endpointId: ep.id, ok, latency };
    } catch (e) {
      const latency = Date.now() - start;
      await prisma.supplierEndpoint.update({
        where: { id: ep.id },
        data: {
          lastHealthAt: now(),
          lastStatus: 'DOWN',
          lastLatencyMs: latency,
          failCount: { increment: 1 }
        }
      });
      await prisma.supplierHealthLog.create({
        data: { endpointId: ep.id, status: 'DOWN', latencyMs: latency, message: String(e?.message || e) }
      });

      return { endpointId: ep.id, ok: false, latency };
    }
  }));

  res.json({ ok: true, checked: results.length, results });
}
