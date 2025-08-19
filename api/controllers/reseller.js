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

// GET mutasi saldo reseller login
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

// Delete reseller
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
