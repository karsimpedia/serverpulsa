import bcrypt from 'bcrypt';
import prisma from '../prisma.js';

export default async function authReseller(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.body?.apikey;
  if (!apiKey) return res.status(401).json({ error: 'API key wajib.' });

  // Cari semua reseller aktif yg punya apiKeyHash lalu compare (bisa dioptimasi dgn hint)
  const candidates = await prisma.reseller.findMany({
    where: { isActive: true, apiKeyHash: { not: null } },
    select: { id: true, userId: true, name: true, apiKeyHash: true, saldo: true },
  });
  for (const r of candidates) {
    const ok = await bcrypt.compare(apiKey, r.apiKeyHash);
    if (ok) { req.reseller = r; return next(); }
  }
  return res.status(403).json({ error: 'API key salah.' });
}
