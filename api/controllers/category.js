
//api/controllers/category

// GET /api/category/resolve?msisdn=...
// POST /api/category/resolve { msisdn }
import prisma from "../prisma.js";

function normalizeMsisdn(input = "") {
  const digits = String(input).replace(/[^\d]/g, "");
  if (!digits) return "";
  return digits.startsWith("62") ? "0" + digits.slice(2) : digits;
}
function makePrefixCandidates(msisdn, { min = 3, max = 8 } = {}) {
  const out = [];
  const upTo = Math.min(max, msisdn.length);
  for (let len = min; len <= upTo; len++) out.push(msisdn.slice(0, len));
  return out;
}

export async function listCategoriesByPrefix(req, res) {
  try {
    const raw = req.method === "GET" ? req.query.msisdn : req.body?.msisdn;
    const msisdn = normalizeMsisdn(raw);

    if (!msisdn) return res.status(400).json({ error: "msisdn wajib diisi." });
    if (msisdn.length < 4)
      return res.status(400).json({ error: "msisdn terlalu pendek." });

    const candidates = makePrefixCandidates(msisdn, { min: 3, max: 8 });

    // Ambil semua prefix yang cocok + kategori terkait
    const hits = await prisma.productCategoryPrefix.findMany({
      where: { prefix: { in: candidates } },
      select: {
        prefix: true,
        category: {
          select: {
            id: true,
            code: true,
            name: true,
            description: true,
            createdAt: true,
          },
        },
      },
    });

    // Urutkan dari prefix terpanjang → terpendek, lalu dedup kategori (unik per id)
    hits.sort((a, b) => b.prefix.length - a.prefix.length);
    const seen = new Set();
    const categories = [];
    for (const h of hits) {
      const c = h.category;
      if (!c) continue;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      categories.push(c);
    }

    return res.json({
      input: { raw, normalized: msisdn },
      candidates,
      category: categories, // <- sesuai format yang kamu inginkan
    });
  } catch (e) {
    console.error("listCategoriesByPrefix:", e);
    return res.status(500).json({ error: "Gagal menentukan kategori dari prefix." });
  }
}




export async function bulkMoveProducts(req, res) {
  try {
    const targetIdRaw = req.params.id;
    const targetId = targetIdRaw === "null" ? null : targetIdRaw;

    const {
      productIds,
      productCodes,
      sourceCategoryId,
      q,
      type,
      active,
      prefix,
    } = req.body || {};

    // Validasi target category jika bukan null
    if (targetId) {
      const target = await prisma.productCategory.findUnique({
        where: { id: targetId },
        select: { id: true },
      });
      if (!target) return res.status(404).json({ error: "Kategori target tidak ditemukan." });
    }

    // Bangun where dinamika untuk pemilihan produk
    let where = {};
    let selectMode = "";

    if (Array.isArray(productIds) && productIds.length) {
      selectMode = "ids";
      where = { id: { in: productIds } };
    } else if (Array.isArray(productCodes) && productCodes.length) {
      selectMode = "codes";
      where = { code: { in: productCodes.map((c) => String(c).trim().toUpperCase()) } };
    } else {
      // Mode filter dari kategori sumber
      selectMode = "filter";
      where = {
        ...(sourceCategoryId ? { categoryId: sourceCategoryId } : {}),
        ...(q
          ? {
              OR: [
                { code: { contains: q, mode: "insensitive" } },
                { name: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(type && (type === "PULSA" || type === "TAGIHAN") ? { type } : {}),
        ...(typeof active === "boolean" ? { isActive: active } : {}),
        ...(prefix ? { code: { startsWith: String(prefix).toUpperCase() } } : {}),
      };
    }

    // Ambil kandidat dulu biar dapat count & preview
    const candidates = await prisma.product.findMany({
      where,
      select: { id: true, code: true, categoryId: true },
    });

    if (candidates.length === 0) {
      return res.status(400).json({ error: "Tidak ada produk yang cocok untuk dipindahkan." });
    }

    // Eksekusi dalam transaksi
    const result = await prisma.$transaction(async (tx) => {
      // Pindahkan
      const upd = await tx.product.updateMany({
        where: { id: { in: candidates.map((x) => x.id) } },
        data: { categoryId: targetId },
      });

      // Info tambahan: hitung per asal kategori
      let affectedBySource = undefined;
      if (sourceCategoryId) {
        const remain = await tx.product.count({ where: { categoryId: sourceCategoryId } });
        affectedBySource = { sourceCategoryId, remaining: remain };
      }

      return { updatedCount: upd.count, affectedBySource };
    });

    return res.json({
      message: "Produk dipindahkan.",
      movedTo: targetId ?? null,
      selectedBy: selectMode,
      selectedCount: candidates.length,
      updatedCount: result.updatedCount,
      ...(result.affectedBySource ? { affectedBySource: result.affectedBySource } : {}),
      sample: candidates.slice(0, 10), // sampel maksimal 10
    });
  } catch (e) {
    console.error("bulkMoveProducts:", e);
    return res.status(500).json({ error: "Gagal memindahkan produk." });
  }
}


export async function updateCategoryById(req, res) {

  console.log( req.body)
  try {
    const { id } = req.params;
    let { name, code, description, prefix, prefixes } = req.body || {};

    if (!id) return res.status(400).json({ error: "Param id wajib." });

    // normalisasi
    const norm = (v) => (v == null ? null : String(v).trim());
    name = norm(name)?.toUpperCase() ?? null;        // boleh null = tidak diubah
    code = norm(code)?.toUpperCase() ?? null;        // boleh null = set null/tidak diubah (lihat di bawah)
    description = norm(description);                 // boleh null

    // ambil raw prefix dari prefix/prefixes
    const raw = prefixes ?? prefix ?? [];

    // parser prefix -> array { prefix, length }
    const toDigits = (s) => String(s || "").replace(/[^\d]/g, "");
    function parseRawPrefixes(input) {
      let arr = [];
      if (typeof input === "string") {
        arr = input.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
      } else if (Array.isArray(input)) {
        arr = input;
      } else if (input) {
        arr = [input];
      }
      const out = [];
      for (const it of arr) {
        if (typeof it === "string") {
          const p = toDigits(it);
          if (p) out.push({ prefix: p, length: p.length });
        } else if (it && typeof it === "object") {
          const p = toDigits(it.prefix);
          if (p) {
            let len = Number(it.length ?? p.length);
            if (!Number.isFinite(len) || len <= 0) len = p.length;
            if (len > 32) len = 32;
            out.push({ prefix: p, length: len });
          }
        }
      }
      // dedup by prefix (ambil yang terakhir)
      const map = new Map();
      for (const r of out) map.set(r.prefix, r);
      return Array.from(map.values());
    }
    const desired = parseRawPrefixes(raw);

    const result = await prisma.$transaction(async (tx) => {
      // pastikan kategori ada
      const existing = await tx.productCategory.findUnique({
        where: { id },
        select: { id: true, name: true, code: true },
      });
      if (!existing) {
        throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      }

      // jika user ingin set code (termasuk dari null -> isi baru), cek konflik
      if (code !== null) {
        // code boleh kosong string? treat sebagai null
        const codeVal = code === "" ? null : code;
        if (codeVal) {
          const conflict = await tx.productCategory.findUnique({
            where: { code: codeVal },
            select: { id: true },
          });
          if (conflict && conflict.id !== id) {
            throw Object.assign(new Error("CODE_CONFLICT"), { code: "CODE_CONFLICT" });
          }
        }
      }

      // susun payload update (hanya field yang dikirim non-undefined yang diupdate)
      const data = {};
      if (name !== null) data.name = name;
      if (description !== undefined) data.description = description; // boleh null untuk hapus
      if (code !== null) data.code = code === "" ? null : code;

      // update kategori utama
      const category = await tx.productCategory.update({
        where: { id },
        data,
        select: { id: true, name: true, code: true, description: true },
      });

      // sinkronisasi prefix (hanya jika user kirim sesuatu untuk prefix)
      let prefixesFinal = [];
      if (raw !== undefined) {
        const existingPrefixes = await tx.productCategoryPrefix.findMany({
          where: { categoryId: id },
          select: { id: true, prefix: true },
        });

        const desiredSet = new Set(desired.map((d) => d.prefix));
        const idsToDelete = existingPrefixes
          .filter((e) => !desiredSet.has(e.prefix))
          .map((e) => e.id);

        if (idsToDelete.length) {
          await tx.productCategoryPrefix.deleteMany({
            where: { id: { in: idsToDelete } },
          });
        }

        for (const d of desired) {
          await tx.productCategoryPrefix.upsert({
            where: { categoryId_prefix: { categoryId: id, prefix: d.prefix } },
            update: { length: d.length },
            create: { categoryId: id, prefix: d.prefix, length: d.length },
          });
        }
      }

      prefixesFinal = await tx.productCategoryPrefix.findMany({
        where: { categoryId: id },
        orderBy: { prefix: "asc" },
      });

      return { category, prefixes: prefixesFinal };
    });

    return res.json({ data: result });
  } catch (e) {
    console.log(e)
    if (e?.code === "NOT_FOUND") {
      return res.status(404).json({ error: "Kategori tidak ditemukan." });
    }
    if (e?.code === "CODE_CONFLICT") {
      return res.status(409).json({ error: "Kode kategori sudah digunakan oleh kategori lain." });
    }
    if (e && e.code === "P2002") {
      const tgt = Array.isArray(e.meta?.target) ? e.meta.target.join(",") : e.meta?.target;
      if (tgt?.includes("name")) {
        return res.status(409).json({ error: "Nama kategori sudah digunakan." });
      }
      if (tgt?.includes("categoryId_prefix")) {
        return res.status(409).json({ error: "Prefix sudah ada pada kategori ini." });
      }
    }
    console.error("updateCategoryById error:", e);
    return res.status(500).json({ error: "Gagal update kategori." });
  }
}




export async function upsertCategory(req, res) {
  try {
    let { name, code, description, prefix, prefixes } = req.body || {};

    // validasi dasar
    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: "Kode kategori wajib diisi." });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Nama kategori wajib diisi." });
    }

    // normalisasi field utama
    const norm = (v) => (v == null ? null : String(v).trim());
    code = norm(code)?.toUpperCase();
    name = norm(name)?.toUpperCase();
    description = norm(description);

    // ambil raw prefix (boleh prefix string, array, atau 'prefixes')
    const raw = prefixes ?? prefix ?? [];

    // normalisasi prefix → array { prefix, length }
    const toDigits = (s) => String(s || "").replace(/[^\d]/g, "");
    function parseRawPrefixes(input) {
      let arr = [];
      if (typeof input === "string") {
        // dukung dipisah koma/newline/titik koma: "0817, 0877;0895"
        arr = input
          .split(/[,\n;]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (Array.isArray(input)) {
        arr = input;
      } else if (input) {
        // objek tunggal
        arr = [input];
      }

      const out = [];
      for (const it of arr) {
        if (typeof it === "string") {
          const p = toDigits(it);
          if (p) out.push({ prefix: p, length: p.length });
        } else if (it && typeof it === "object") {
          const p = toDigits(it.prefix);
          if (p) {
            let len = Number(it.length ?? p.length);
            if (!Number.isFinite(len) || len <= 0) len = p.length;
            if (len > 32) len = 32; // batas wajar
            out.push({ prefix: p, length: len });
          }
        }
      }

      // dedup per prefix (pakai yang terakhir)
      const map = new Map();
      for (const r of out) map.set(r.prefix, r);
      return Array.from(map.values());
    }

    const desired = parseRawPrefixes(raw);

    const result = await prisma.$transaction(async (tx) => {
      // upsert kategori (unik by code)
      const category = await tx.productCategory.upsert({
        where: { code },
        update: { name, description },
        create: { code, name, description },
      });

      // ambil prefix existing
      const existing = await tx.productCategoryPrefix.findMany({
        where: { categoryId: category.id },
        select: { id: true, prefix: true },
      });

      const desiredSet = new Set(desired.map((d) => d.prefix));

      // hapus yang tidak diinginkan lagi
      const idsToDelete = existing
        .filter((e) => !desiredSet.has(e.prefix))
        .map((e) => e.id);

      if (idsToDelete.length) {
        await tx.productCategoryPrefix.deleteMany({
          where: { id: { in: idsToDelete } },
        });
      }

      // upsert yang baru / update length
      for (const d of desired) {
        await tx.productCategoryPrefix.upsert({
          // gunakan unique compound @@unique([categoryId, prefix])
          where: {
            categoryId_prefix: { categoryId: category.id, prefix: d.prefix },
          },
          update: { length: d.length },
          create: {
            categoryId: category.id,
            prefix: d.prefix,
            length: d.length,
          },
        });
      }

      // hasil akhir
      const prefixesFinal = await tx.productCategoryPrefix.findMany({
        where: { categoryId: category.id },
        orderBy: { prefix: "asc" },
      });

      return { category, prefixes: prefixesFinal };
    });

    return res.json({ data: result });
  } catch (e) {
    // tangani error unik prisma bila perlu
    if (e && e.code === "P2002") {
      const tgt = Array.isArray(e.meta?.target)
        ? e.meta.target.join(",")
        : e.meta?.target;
      if (tgt?.includes("code")) {
        return res.status(409).json({ error: "Kode kategori sudah digunakan." });
      }
      if (tgt?.includes("name")) {
        return res.status(409).json({ error: "Nama kategori sudah digunakan." });
      }
      if (tgt?.includes("categoryId_prefix")) {
        return res
          .status(409)
          .json({ error: "Prefix sudah ada pada kategori ini." });
      }
    }

    console.error("upsertCategory error:", e);
    return res.status(500).json({ error: "Gagal upsert kategori." });
  }
}



// GET /api/category?page=&limit=


export async function listCategories(req, res) {
  try {
    const page  = Math.max(parseInt(req.query.page ?? "1"), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? "20"), 1), 100);
    const skip  = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.productCategory.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { products: true } },
          // ambil hanya kolom prefix supaya ringan
          prefixes: {
            select: { prefix: true },
            orderBy: { prefix: "asc" },
          },
        },
      }),
      prisma.productCategory.count(),
    ]);

    // ubah prefixes dari [{prefix:"0817"}, ...] -> ["0817", ...]
    const data = rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      description: r.description,
      createdAt: r.createdAt,
      _count: r._count,
      prefixes: (r.prefixes || []).map((p) => p.prefix),
    }));

    res.json({
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    console.error("listCategories:", e);
    res.status(500).json({ error: "Gagal mengambil kategori." });
  }
}

// GET /api/category/:id
// GET /api/category/:id
export async function getCategoryById(req, res) {
  try {
    const { id } = req.params;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

    const cat = await prisma.productCategory.findFirst({
      where: isUuid ? { id } : { code: id },
      include: {
        _count: {
          select: { products: true, prefixes: true },
        },
        prefixes: {
          select: { prefix: true }, // ambil kolom prefix saja
          orderBy: { prefix: "asc" },
        },
      },
    });

    if (!cat) {
      return res.status(404).json({ error: "Kategori tidak ditemukan." });
    }

    // ubah objek prefixes { prefix: "0817" } jadi array string
    const result = {
      ...cat,
      prefixes: cat.prefixes.map((p) => p.prefix),
    };

    res.json({ data: result });
  } catch (e) {
    console.error("getCategoryById:", e);
    res.status(500).json({ error: "Gagal mengambil kategori." });
  }
}


// GET /api/category/:id/products?type=&active=&page=&limit=&q=
export async function getCategoryProducts(req, res) {
  try {
    const { id }    = req.params;
    const q         = (req.query.q ?? "").toString().trim();
    const type      = (req.query.type ?? "").toString().toUpperCase(); // PULSA/TAGIHAN
    const activeQ   = req.query.active; // "true"/"false"
    const page      = Math.max(parseInt(req.query.page ?? "1"), 1);
    const limit     = Math.min(Math.max(parseInt(req.query.limit ?? "20"), 1), 100);
    const skip      = (page - 1) * limit;

    // pastikan kategori ada
    const cat = await prisma.productCategory.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!cat) return res.status(404).json({ error: "Kategori tidak ditemukan." });

    const where = {
      categoryId: id,
      ...(q ? { OR: [
        { code: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ] } : {}),
      ...(type && (type === "PULSA" || type === "TAGIHAN") ? { type } : {}),
      ...(typeof activeQ !== "undefined" ? { isActive: activeQ === "true" } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip, take: limit,
        orderBy: [{ isActive: "desc" }, { code: "asc" }],
      }),
      prisma.product.count({ where }),
    ]);

    res.json({
      category: cat,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    console.error("getCategoryProducts:", e);
    res.status(500).json({ error: "Gagal mengambil produk kategori." });
  }
}

// DELETE /api/category/:id
export async function deleteCategory(req, res) {
  try {
    const { id } = req.params;
    const inUse = await prisma.product.count({ where: { categoryId: id } });
    if (inUse > 0) {
      return res.status(409).json({ error: "Kategori dipakai oleh produk. Pindahkan/hapus produk terlebih dahulu." });
    }
    await prisma.productCategory.delete({ where: { id } });
    res.json({ message: "Kategori dihapus." });
  } catch (e) {
    console.error("deleteCategory:", e);
    res.status(500).json({ error: "Gagal menghapus kategori." });
  }
}



// ====================== PREFIX KATEGORI ======================

// GET /api/category/:id/prefixes
export async function listCategoryPrefixes(req, res) {
  try {
    const { id } = req.params;
    const cat = await prisma.productCategory.findUnique({
      where: { id },
      select: { id: true, name: true, code: true, description: true,  },
    });
    if (!cat) return res.status(404).json({ error: "Kategori tidak ditemukan." });

    const rows = await prisma.productCategoryPrefix.findMany({
      where: { categoryId: id },
      orderBy: [{ length: "desc" }, { prefix: "asc" }],
    });

    res.json({ category: cat, data: rows });
  } catch (e) {
    console.error("listCategoryPrefixes:", e);
    res.status(500).json({ error: "Gagal mengambil prefix kategori." });
  }
}

// POST /api/category/:id/prefixes/bulk
// body: { prefixes: string[] }  -> contoh: ["0817","0818","0819"]
// POST /api/category/:id/prefixes/bulk
export async function bulkAddCategoryPrefixes(req, res) {
  try {
    const { id } = req.params;

    // Pastikan kategori ada
    const cat = await prisma.productCategory.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!cat) return res.status(404).json({ error: "Kategori tidak ditemukan." });

    const body = req.body ?? {};

    // Kumpulkan sumber input: prefixes[], items[], prefix (string), atau body raw string
    const collected = [];

    if (Array.isArray(body.prefixes)) {
      collected.push(...body.prefixes);
    }
    if (Array.isArray(body.items)) {
      // items: [{ prefix, length? }]
      for (const it of body.items) {
        const pref = String(it?.prefix ?? "").replace(/\D/g, "");
        if (!pref) continue;
        const length = Number.isInteger(it?.length) ? Number(it.length) : pref.length;
        collected.push({ prefix: pref, length });
      }
    }
    if (typeof body.prefix === "string") {
      collected.push(body.prefix);
    }
    if (typeof body === "string") {
      collected.push(body);
    }

    // Normalisasi: jadikan array objek { prefix, length }
    const items = [];
    for (const entry of collected) {
      if (entry && typeof entry === "object" && "prefix" in entry) {
        const pref = String(entry.prefix ?? "").replace(/\D/g, "");
        if (!pref) continue;
        const length = Number.isInteger(entry.length) ? Number(entry.length) : pref.length;
        items.push({ prefix: pref, length });
      } else {
        const pref = String(entry ?? "").replace(/\D/g, "");
        if (!pref) continue;
        items.push({ prefix: pref, length: pref.length });
      }
    }

    // Filter: panjang 3–5 digit, unik
    const seen = new Set();
    const cleaned = items.filter(({ prefix, length }) => {
      if (prefix.length < 3 || prefix.length > 5) return false;
      if (seen.has(prefix)) return false;
      seen.add(prefix);
      return true;
    });

    if (cleaned.length === 0) {
      return res.status(400).json({ error: "Tidak ada prefix valid (3–5 digit)." });
    }

    // Upsert berdasarkan unique (categoryId, prefix)
    const ops = cleaned.map(({ prefix, length }) =>
      prisma.productCategoryPrefix.upsert({
        where: { categoryId_prefix: { categoryId: id, prefix } },
        create: { categoryId: id, prefix, length },
        update: {},
      })
    );

    await prisma.$transaction(ops);

    // Kembalikan daftar terbaru untuk memudahkan UI sinkron
    const latest = await prisma.productCategoryPrefix.findMany({
      where: { categoryId: id },
      orderBy: { prefix: "asc" },
      select: { id: true, categoryId: true, prefix: true, length: true, createdAt: true },
    });

    res.json({ addedOrKept: cleaned.length, data: latest });
  } catch (e) {
    console.error("bulkAddCategoryPrefixes:", e);
    res.status(500).json({ error: "Gagal menambahkan prefix." });
  }
}

// PUT /api/category/:id/prefixes
// body: { prefixes: string[] } -> replace semua prefix kategori (idempotent)
export async function replaceCategoryPrefixes(req, res) {
  try {
    const { id } = req.params;
    const cat = await prisma.productCategory.findUnique({ where: { id }, select: { id: true } });
    if (!cat) return res.status(404).json({ error: "Kategori tidak ditemukan." });

    let { prefixes = [] } = req.body || {};
    if (!Array.isArray(prefixes)) prefixes = [];

    const cleaned = Array.from(
      new Set(
        prefixes
          .map((p) => String(p || "").replace(/\D/g, ""))
          .filter((p) => p.length >= 3 && p.length <= 5)
      )
    );

    await prisma.$transaction(async (tx) => {
      await tx.productCategoryPrefix.deleteMany({ where: { categoryId: id } });
      if (cleaned.length) {
        await tx.productCategoryPrefix.createMany({
          data: cleaned.map((pref) => ({
            categoryId: id,
            prefix: pref,
            length: pref.length,
          })),
          skipDuplicates: true,
        });
      }
    });

    const rows = await prisma.productCategoryPrefix.findMany({
      where: { categoryId: id },
      orderBy: [{ length: "desc" }, { prefix: "asc" }],
    });

    res.json({ replaced: true, count: rows.length, data: rows });
  } catch (e) {
    console.error("replaceCategoryPrefixes:", e);
    res.status(500).json({ error: "Gagal mengganti prefix kategori." });
  }
}

// DELETE /api/category/:id/prefixes/:prefixId
export async function deleteCategoryPrefix(req, res) {
  try {
    const { id, prefixId } = req.params;
    // pastikan prefix memang milik kategori tsb
    const row = await prisma.productCategoryPrefix.findUnique({ where: { id: prefixId } });
    if (!row || row.categoryId !== id) {
      return res.status(404).json({ error: "Prefix tidak ditemukan di kategori ini." });
    }
    await prisma.productCategoryPrefix.delete({ where: { id: prefixId } });
    res.json({ ok: true });
  } catch (e) {
    console.error("deleteCategoryPrefix:", e);
    res.status(500).json({ error: "Gagal menghapus prefix." });
  }
}
