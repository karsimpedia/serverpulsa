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
async function isAncestorOf(uplineId, childId) {
  if (!uplineId || !childId || uplineId === childId) return false;
  let node = await prisma.reseller.findUnique({
    where: { id: childId },
    select: { parentId: true },
  });
  const seen = new Set([childId]);
  let hop = 0;
  while (node?.parentId && hop < 50) {
    if (node.parentId === uplineId) return true;
    if (seen.has(node.parentId)) break; // antisipasi loop
    seen.add(node.parentId);
    node = await prisma.reseller.findUnique({
      where: { id: node.parentId },
      select: { parentId: true },
    });
    hop++;
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

function toPlain(obj) {
  return JSON.parse(
    JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}
export async function setDownlineGlobalMarkup(req, res) {
  try {
    const meId = req.user?.resellerId || null;
    const role = req.user?.role || "RESELLER";
    const downlineId = String(req.params.downlineId || "").trim().toUpperCase(); 

    if (!meId) return res.status(401).json({ error: "Unauthorized (resellerId tidak ada)" });
    if (!downlineId) return res.status(400).json({ error: "Param downlineId wajib" });

    const { markup } = req.body || {};
    if (markup == null) return res.status(400).json({ error: "markup wajib" });

    // Validasi → BigInt integer, >= 0
    let mk;
    try {
      if (String(markup).includes(".")) {
        return res.status(400).json({ error: "markup harus bilangan bulat (integer)" });
      }
      mk = BigInt(markup);
    } catch {
      return res.status(400).json({ error: "markup harus integer yang valid" });
    }
    if (mk < 0n) return res.status(400).json({ error: "markup tidak boleh negatif" });
    if (mk > 100000n) {
      return res.status(400).json({ error: "markup terlalu besar (maks 100000)" });
    }

    // Pastikan target downline ada
    const target = await prisma.reseller.findUnique({
      where: { id: downlineId },
      select: { id: true, parentId: true, name: true },
    });
    if (!target) return res.status(404).json({ error: "Reseller target tidak ditemukan" });

    // Izin: ADMIN atau ancestor
    if (role !== "ADMIN") {
      const allowed = await isAncestorOf(meId, downlineId);
      if (!allowed) {
        return res.status(403).json({ error: "Forbidden: bukan upline/ancestor dari target" });
      }
    }

    // Upsert ke tabel ResellerGlobalMarkup (pk: resellerId)
    const record = await prisma.resellerGlobalMarkup.upsert({
      where: { resellerId: downlineId },
      create: { resellerId: downlineId, markup: mk },
      update: { markup: mk },
    });

    return res.json(
      toPlain({
        ok: true,
        uplineId: meId,
        downlineId,
        markup: mk,   // akan jadi string oleh toPlain()
        record,       // termasuk field BigInt di-convert oleh toPlain
      })
    );
  } catch (e) {
    console.error("setDownlineGlobalMarkup error:", e);
    return res.status(500).json({ error: e.message || "Gagal set global markup downline" });
  }
}