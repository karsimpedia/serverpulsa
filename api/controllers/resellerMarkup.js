// api/controllers/resellerMarkup.js
import prisma from '../prisma.js';

export async function upsertResellerMarkup(req, res) {
  try {
    const { resellerId, productId, markup } = req.body;
    if (!resellerId || !productId || markup == null) {
      return res.status(400).json({ error: 'resellerId, productId, markup wajib' });
    }
    const mk = BigInt(markup);
    if (mk < 0n) return res.status(400).json({ error: 'markup tidak boleh negatif' });

    const MAX_MARKUP = BigInt(process.env.MAX_MARKUP || 10_000_000);
    if (mk > MAX_MARKUP) return res.status(400).json({ error: `markup melebihi batas ${MAX_MARKUP}` });

    const data = await prisma.resellerMarkup.upsert({
      where: { resellerId_productId: { resellerId, productId } },
      create: { resellerId, productId, markup: mk },
      update: { markup: mk }
    });

    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}
