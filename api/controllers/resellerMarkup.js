// api/controllers/resellerMarkup.js
import prisma from '../prisma.js';


const MAX_MARKUP = BigInt(process.env.MAX_MARKUP || '10000000'); // 10 jt default

function parseMarkup(v) {
  const bi = BigInt(
    typeof v === 'string' ? v.trim() : String(Math.floor(Number(v || 0)))
  );
  if (bi < 0n) throw new Error('markup tidak boleh negatif');
  if (bi > MAX_MARKUP) throw new Error(`markup melebihi batas ${MAX_MARKUP.toString()}`);
  return bi;
}

/**
 * Cek apakah uplineId adalah ancestor (upline di level berapapun) dari targetId.
 * Return true kalau iya. Tidak mengizinkan self (uplineId === targetId) secara default.
 */
async function isAncestorOf(uplineId, targetId) {
  if (!uplineId || !targetId) return false;
  if (uplineId === targetId) return false; // ubah ke true kalau mau izinkan self
  let cur = targetId;
  const seen = new Set();
  for (let i = 0; i < 50 && cur; i++) {
    if (seen.has(cur)) break; // guard siklus
    seen.add(cur);
    const r = await prisma.reseller.findUnique({
      where: { id: cur },
      select: { parentId: true }
    });
    const p = r?.parentId || null;
    if (!p) break;
    if (p === uplineId) return true;
    cur = p;
  }
  return false;
}



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




function parseBigIntNonNeg(v) {
  const bi = BigInt(
    typeof v === 'string' ? v.trim() : String(Math.floor(Number(v || 0)))
  );
  if (bi < 0n) throw new Error('markup tidak boleh negatif');
  if (bi > MAX_MARKUP) throw new Error(`markup melebihi batas ${MAX_MARKUP.toString()}`);
  return bi;
}

// SET / UPSERT markup global (berlaku semua produk; bisa dioverride per-produk)
export async function upsertResellerGlobalMarkup(req, res) {
  try {
    const { resellerId, markup } = req.body || {};
    if (!resellerId || markup == null) {
      return res.status(400).json({ error: 'resellerId dan markup wajib' });
    }
    const mk = parseBigIntNonNeg(markup);

    const data = await prisma.resellerGlobalMarkup.upsert({
      where: { resellerId },
      create: { resellerId, markup: mk },
      update: { markup: mk },
      select: { resellerId: true, markup: true }
    });

    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Gagal menyimpan markup global' });
  }
}

// GET markup global (untuk admin UI)
export async function getResellerGlobalMarkup(req, res) {
  try {
    const { resellerId } = req.params;
    if (!resellerId) return res.status(400).json({ error: 'resellerId wajib' });

    const row = await prisma.resellerGlobalMarkup.findUnique({
      where: { resellerId },
      select: { resellerId: true, markup: true }
    });

    return res.json({ ok: true, data: row || { resellerId, markup: '0' } });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Gagal mengambil markup global' });
  }
}

// HAPUS / RESET markup global (jadi 0)
export async function deleteResellerGlobalMarkup(req, res) {
  try {
    const { resellerId } = req.params;
    if (!resellerId) return res.status(400).json({ error: 'resellerId wajib' });

    await prisma.resellerGlobalMarkup.delete({
      where: { resellerId }
    }).catch(() => null);

    return res.json({ ok: true, deleted: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Gagal menghapus markup global' });
  }
}

export async function setGlobalMarkupForDownline(req, res) {
  try {
    const { targetResellerId, markup } = req.body;
    if (!targetResellerId || markup == null) {
      return res.status(400).json({ error: "targetResellerId & markup wajib" });
    }
    const mk = BigInt(markup);
    if (mk < 0n) return res.status(400).json({ error: "markup tidak boleh negatif" });

    // izin: ADMIN atau upline dari targetResellerId
    const me = req.params.id;
    const role = req.user?.role;
    if (role !== "ADMIN") {
      // cek apakah `me` adalah ancestor dari targetResellerId
      const isAncestor = await isAncestorOf(me, targetResellerId);
      if (!isAncestor) {
        return res.status(403).json({ error: "Forbidden: bukan upline dari target" });
      }
    }

    const data = await prisma.resellerGlobalMarkup.upsert({
      where: { resellerId: targetResellerId },
      create: { resellerId: targetResellerId, markup: mk },
      update: { markup: mk },
    });

    return res.json({ ok: true, data });
  } catch (e) {
    console.error("setGlobalMarkupForDownline error:", e);
    return res.status(500).json({ error: e.message });
  }
}
