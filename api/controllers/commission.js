import prisma from '../prisma.js';

// GET semua rule milik upline (login)
export async function listMyCommissionRules(req, res) {
  const me = req.reseller.id;
  const rows = await prisma.commissionFlat.findMany({
    where: { resellerId: me },
    orderBy: [{ level: 'asc' }, { productId: 'asc' }],
  });
  res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })));
}

// UPSERT rule (global atau per product)
export async function upsertMyCommissionRule(req, res) {
  const me = req.reseller.id;
  const { level, amount, productId } = req.body;

  if (!level || level < 1) return res.status(400).json({ error: 'level minimal 1' });
  if (amount == null) return res.status(400).json({ error: 'amount wajib' });

  try {
    const row = await prisma.commissionFlat.upsert({
      where: {
        resellerId_level_productId: {
          resellerId: me,
          level: Number(level),
          productId: productId ?? null,
        },
      },
      update: { amount: BigInt(amount) },
      create: {
        resellerId: me,
        level: Number(level),
        amount: BigInt(amount),
        productId: productId ?? null,
      }
    });
    res.json({ ...row, amount: Number(row.amount) });
  } catch (e) {
    console.error('upsertMyCommissionRule error:', e);
    res.status(500).json({ error: 'Gagal menyimpan rule' });
  }
}

// HAPUS rule
export async function deleteMyCommissionRule(req, res) {
  const me = req.reseller.id;
  const { level, productId } = req.body;
  if (!level || level < 1) return res.status(400).json({ error: 'level wajib' });

  try {
    await prisma.commissionFlat.delete({
      where: {
        resellerId_level_productId: {
          resellerId: me,
          level: Number(level),
          productId: productId ?? null,
        },
      },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: 'Rule tidak ditemukan' });
  }
}
