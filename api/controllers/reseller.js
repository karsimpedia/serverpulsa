// api/controllers/reseller.js
import prisma from "../prisma.js";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { generateResellerId } from "../../utils/idGenerator.js";

// GET saldo reseller login
export async function getSaldo(req, res) {
  console.log(req.params.id)
  try {
    const saldo = await prisma.saldo.findUnique({
      where: { resellerId: req.params.id },
    });
    res.json({ amount: Number(saldo?.amount ?? 0n) });
  } catch (err) {
    console.error("Get saldo error:", err);
    res.status(500).json({ error: "Gagal mengambil saldo" });
  }
}

// list transaksi reseller Login
export async function listTransactions(req, res) {
  try {
    const resellerId = req.user?.resellerId;
    if (!resellerId) {
      return res.status(401).json({ error: "Unauthorized (resellerId tidak ada)" });
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 200);
    const skip = (page - 1) * limit;

    const { status, msisdn, idOrInvoice, q } = req.query;

    const where = { resellerId };
    if (status) where.status = String(status).toUpperCase();
    if (msisdn) where.msisdn = { contains: msisdn, mode: "insensitive" };
    if (idOrInvoice) {
      where.OR = [
        { id: idOrInvoice },
        { invoiceId: idOrInvoice }
      ];
    }
    if (q) {
      where.OR = [
        { msisdn: { contains: q, mode: "insensitive" } },
        { invoiceId: { contains: q, mode: "insensitive" } }
      ];
    }

    const [total, data] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          invoiceId: true,
          msisdn: true,
          status: true,
          sellPrice: true,
          createdAt: true,
          product: { select: { code: true, name: true, nominal: true } },
        }
      }),
    ]);

    res.json({
      page,
      limit,
      total,
      resellerId,
      data,
    });
  } catch (err) {
    console.error("listTransactions error:", err);
    res.status(500).json({ error: "Gagal memuat data transaksi" });
  }
}

// GET mutasi saldo resller by admin
export async function getMutasi(req, res) {

  const id = req.params.id
  try {
    const take = Number(req.query.take || 20);
    const skip = Number(req.query.skip || 0);
    const rows = await prisma.mutasiSaldo.findMany({
      where: { resellerId: id },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    });
    res.json(
      rows.map((r) => ({
        ...r,
        amount: Number(r.amount),
      }))
    );
  } catch (err) {
    console.error("Get mutasi error:", err);
    res.status(500).json({ error: "Gagal mengambil mutasi saldo" });
  }
}

export async function getMutasibyReseller(req, res) {

  const id = req.user.resellerId
  try {
    const take = Number(req.query.take || 20);
    const skip = Number(req.query.skip || 0);
    const rows = await prisma.mutasiSaldo.findMany({
      where: { resellerId: id },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    });
    res.json(
      rows.map((r) => ({
        ...r,
        afterAmount: Number(r.afterAmount),
        beforeAmount: Number(r.beforeAmount),
        amount: Number(r.amount),
      }))
    );
  } catch (err) {
    console.error("Get mutasi error:", err);
    res.status(500).json({ error: "Gagal mengambil mutasi saldo" });
  }
}


// POST buat callback per reseller
export async function createResellerCallback(req, res) {
  try {
    const { url, secret, isActive } = req.body;
    if (!url) return res.status(400).json({ error: "URL wajib diisi" });

    const cb = await prisma.resellerCallback.create({
      data: {
        resellerId: req.reseller.id,
        url,
        secret: secret || null,
        isActive: isActive ?? true,
      },
    });
    res.status(201).json(cb);
  } catch (err) {
    console.error("Create callback error:", err);
    res.status(500).json({ error: "Gagal membuat callback" });
  }
}

// Create new reseller


const normalizePhone = (s="") => s.replace(/[^\d]/g,''); // keep digits only
const normalizeCode  = (s="") => s.trim().toUpperCase().replace(/\s+/g,'');
async function ensureResellerSeq(tx) {
  // Buat sequence jika belum ada
  await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS public.reseller_seq START 1`);

  // Sinkronkan posisi sequence dengan ID terbesar yang formatnya LAxxxx
  await tx.$executeRawUnsafe(`
    SELECT setval(
      'public.reseller_seq',
      GREATEST(
        COALESCE((SELECT last_value FROM public.reseller_seq), 0),
        COALESCE((
          SELECT MAX(CAST(SUBSTRING(id, 3) AS INTEGER))
          FROM "Reseller"
          WHERE id ~ '^LA[0-9]+$'
        ), 0)
      ),
      true
    )
  `);
}

async function nextResellerId(tx) {
  // pastikan sequence tersedia & sinkron
  await ensureResellerSeq(tx);

  const rows = await tx.$queryRaw`SELECT nextval('public.reseller_seq') AS v`;
  const num = Number(rows[0].v);
  return `LA${String(num).padStart(4, "0")}`;
}
// helper ambil nomor berikutnya dari sequence (atomic)

export const registerReseller = async (req, res) => {
  try {
    const { name, username, password, referralCode, pin, phonenumber , address} = req.body;
    if (!name || !username || !password || !phonenumber) {
      return res.status(400).json({ error: "Name, username, password, dan phone number wajib diisi." });
    }
    const phone = normalizePhone(phonenumber);
    if (phone.length < 8) return res.status(400).json({ error: "Nomor HP tidak valid." });

    const result = await prisma.$transaction(async (tx) => {
      let reseller; // <-- deklarasi di atas
 const plainApiKey = randomBytes(32).toString("hex");
     
     console.log(plainApiKey)// 64 karakter hex
      const apiKeyHash = await bcrypt.hash(plainApiKey, 10); // simpan di DB
      // username unik
      const existingUser = await tx.user.findUnique({ where: { username } });
      if (existingUser) throw new Error("USERNAME_TAKEN");

      // referrer (opsional)
      let parent = null;
      if (referralCode) {
        const codeRef = normalizeCode(referralCode);
        parent = await tx.reseller.findUnique({ where: { referralCode: codeRef } });
        if (!parent) throw new Error("REFERRER_NOT_FOUND");
      }

      // phone unik
      const existingPhone = await tx.device.findUnique({ where: { identifier: phone } });
      if (existingPhone) throw new Error("PHONE_TAKEN");

      // hash
      const hashedPassword = await bcrypt.hash(password, 10);
      const pinHashed      = await bcrypt.hash(pin || "123456", 10);

      // user
      const user = await tx.user.create({
        data: { username, password: hashedPassword, role: "RESELLER" },
        select: { id: true },
      });

      // id LAxxxx
      const newId = await nextResellerId(tx);

      // reseller
      reseller = await tx.reseller.create({
        data: {
          id: newId,
          userId: user.id,
          name,
          apiKeyHash: apiKeyHash,
          isActive: true,
          referralCode: normalizeCode(newId),
          pin: pinHashed,
          parentId: parent?.id ?? null,
          address
        },
      });

      // saldo
      await tx.saldo.upsert({
        where: { resellerId: reseller.id },
        update: {},
        create: { resellerId: reseller.id, amount: BigInt(0) },
      });

      // device
      await tx.device.create({
        data: { resellerId: reseller.id, type: "PHONE", identifier: phone, isActive: true },
      });

      return reseller;
    });

    res.status(201).json({ message: "Reseller berhasil didaftarkan.", reseller: result });
  } catch (err) {
    if (err.message === "USERNAME_TAKEN")     return res.status(409).json({ error: "Username sudah digunakan." });
    if (err.message === "REFERRER_NOT_FOUND") return res.status(404).json({ error: "Kode referral tidak ditemukan." });
    if (err.message === "PHONE_TAKEN")        return res.status(409).json({ error: "No HP sudah terdaftar." });
    if (err.code === "P2002") {
      const fields = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : "field unik";
      return res.status(409).json({ error: `Data duplikat pada ${fields}.` });
    }
    console.error("Register reseller error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

// util yang dipakai



// List all resellers
export async function resellerList(req, res) {
  try {
    const resellers = await prisma.reseller.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        parent: { select: { id: true, name: true } },
        devices: true,
        saldo: true,
        user: { select: { username: true } },
      },
    });
    res.json({
      data: resellers.map((r) => ({
        ...r,
        saldo: r.saldo ? Number(r.saldo.amount) : 0,
      })),
    });
  } catch (err) {
    console.error("Fetch resellers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// Update reseller
export async function updateReseller(req, res) {
  try {
    const { id } = req.params;
    const { name, password, pin, address, parentId, isActive } = req.body;

    const existing = await prisma.reseller.findUnique({ where: { id } });
    if (!existing)
      return res.status(404).json({ error: "Reseller tidak ditemukan" });

    const data = {};
    if (name) data.name = name;
    if (address) data.address = address;
    if (isActive !== undefined) data.isActive = !!isActive;

    // Update password di tabel User
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await prisma.user.update({
        where: { id: existing.userId },
        data: { password: hashedPassword },
      });
    }

    // Update pin di tabel Reseller
    if (pin) {
      if (!/^\d{6}$/.test(pin)) {
        return res
          .status(400)
          .json({ error: "PIN harus berupa 6 digit angka" });
      }
      data.pin = await bcrypt.hash(pin, 10);
    }

    if (parentId !== undefined) {
      if (parentId) {
        const parent = await prisma.reseller.findUnique({
          where: { id: parentId },
        });
        if (!parent)
          return res.status(400).json({ error: "Upline tidak valid" });
        data.parentId = parentId;
      } else {
        data.parentId = null;
      }
    }

    const updated = await prisma.reseller.update({ where: { id }, data });
    res.json({ message: "Reseller berhasil diperbarui", reseller: updated });
  } catch (err) {
    console.error("Update reseller error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// Delete reseller admin
export async function deleteReseller(req, res) {
  try {
    const { id } = req.params;
    const existing = await prisma.reseller.findUnique({ where: { id } });
    if (!existing)
      return res.status(404).json({ error: "Reseller tidak ditemukan" });

    await prisma.reseller.delete({ where: { id } });
    res.json({ message: "Reseller berhasil dihapus" });
  } catch (err) {
    console.error("Delete reseller error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}




/**
 * GET /api/reseller/downlines
 * Mengembalikan daftar downline langsung dari reseller login
 * Response:
 * {
 *   "resellerId": "LA0001",
 *   "total": 2,
 *   "downlines": [
 *     { "id": "LA0003", "name": "Downline A", "phone": "0812...", "createdAt": "..." },
 *     { "id": "LA0004", "name": "Downline B", "phone": "0813...", "createdAt": "..." }
 *   ]
 * }
 */

function toPlain(obj) {
  return JSON.parse(
    JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

export async function listMyDownlines(req, res) {
  try {
    const meId = req.user?.resellerId;
    if (!meId) return res.status(401).json({ error: "Unauthorized (resellerId tidak ada)" });

    const downlines = await prisma.reseller.findMany({
      where: { parentId: meId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        // NB: back-relation kamu didefinisikan sebagai array.
        // Ambil elemen pertama saja (harusnya one-to-one).
        ResellerGlobalMarkup: {
          select: { markup: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const withMarkup = downlines.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      // kalau belum ada record global markup, default 0n
      markup: (d.ResellerGlobalMarkup?.[0]?.markup ?? 0n),
    }));

    return res.json(
      toPlain({
        resellerId: meId,
        total: withMarkup.length,
        downlines: withMarkup,
      })
    );
  } catch (err) {
    console.error("listMyDownlines error:", err);
    res.status(500).json({ error: "Gagal memuat daftar downline" });
  }
}

