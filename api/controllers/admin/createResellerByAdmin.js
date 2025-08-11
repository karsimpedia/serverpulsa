// api/controllers/admin/createResellerByAdmin.js
import prisma from "../../prisma.js";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";

// === Jika helper ini sudah ada di tempat lain, hapus definisi di bawah & import dari utils ===
const normalizePhone = (s="") => s.replace(/[^\d]/g,''); // keep digits only
const normalizeCode  = (s="") => s.trim().toUpperCase().replace(/\s+/g,'');

async function ensureResellerSeq(tx) {
  await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS public.reseller_seq START 1`);
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
  await ensureResellerSeq(tx);
  const rows = await tx.$queryRaw`SELECT nextval('public.reseller_seq') AS v`;
  const num = Number(rows[0].v);
  return `LA${String(num).padStart(4, "0")}`;
}
// === END helper ===

/**
 * Body JSON (semua opsional kecuali name & phonenumber & username):
 * {
 *   "name": "Toko Andi",                  // wajib
 *   "username": "andi_store",             // wajib (unik)
 *   "password": "Rahasia123!",            // opsional, jika kosong akan di-generate
 *   "pin": "123456",                      // opsional, default "123456"
 *   "phonenumber": "62812-3456-7890",     // wajib (unik di Device.identifier)
 *   "referralCode": "LA0001",             // opsional (parent via referralCode) — prioritas
 *   "parentId": "LA0001",                 // opsional (parent langsung)
 *   "initialSaldo": 0,                    // opsional number >= 0
 *   "isActive": true                      // opsional, default true
 * }
 *
 * Response akan berisi:
 * - plainApiKey   : tampil sekali
 * - tempPassword  : jika password tidak dikirim, password dibikinkan
 */
export async function createResellerByAdmin(req, res) {
  try {
    const {
      name,
      username,
      password,
      pin = "123456",
      phonenumber,
      referralCode,
      parentId,
      initialSaldo = 0,
      isActive = true,
    } = req.body ?? {};

    // Validasi dasar
    if (!name || !username || !phonenumber) {
      return res.status(400).json({ error: "name, username, dan phonenumber wajib diisi." });
    }
    if (!/^\d{6}$/.test(String(pin))) {
      return res.status(400).json({ error: "PIN harus 6 digit angka." });
    }
    if (typeof initialSaldo !== "number" || isNaN(initialSaldo) || initialSaldo < 0) {
      return res.status(400).json({ error: "initialSaldo harus number >= 0." });
    }

    const phone = normalizePhone(phonenumber);
    if (phone.length < 8) {
      return res.status(400).json({ error: "Nomor HP tidak valid." });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Cek username unik
      const existingUser = await tx.user.findUnique({ where: { username } });
      if (existingUser) throw new Error("USERNAME_TAKEN");

      // Cek phone unik di Device.identifier
      const existingPhone = await tx.device.findUnique({ where: { identifier: phone } });
      if (existingPhone) throw new Error("PHONE_TAKEN");

      // Tentukan parent (opsional): referralCode > parentId
      let parent = null;
      if (referralCode) {
        const codeRef = normalizeCode(referralCode);
        parent = await tx.reseller.findUnique({ where: { referralCode: codeRef } });
        if (!parent) throw new Error("REFERRER_NOT_FOUND");
      } else if (parentId) {
        parent = await tx.reseller.findUnique({ where: { id: parentId } });
        if (!parent) throw new Error("PARENT_NOT_FOUND");
      }

      // Siapkan kredensial
      const tempPassword = password?.trim() || Math.random().toString(36).slice(-10); // auto-gen jika kosong
      const hashedPassword = await bcrypt.hash(tempPassword, 10);
      const pinHashed      = await bcrypt.hash(pin, 10);

      // Buat user (role RESELLER)
      const user = await tx.user.create({
        data: { username, password: hashedPassword, role: "RESELLER" },
        select: { id: true },
      });

      // ID reseller LAxxxx via sequence
      const newId = await nextResellerId(tx);

      // API key (hash disimpan, plain dikembalikan sekali)
      const plainApiKey = randomBytes(32).toString("hex"); // 64 hex
      const apiKeyHash  = await bcrypt.hash(plainApiKey, 10);

      // Buat reseller
      const reseller = await tx.reseller.create({
        data: {
          id: newId,
          userId: user.id,
          name,
          apiKeyHash,
          isActive: Boolean(isActive),
          referralCode: normalizeCode(newId), // referral self-code = ID normalized
          pin: pinHashed,
          parentId: parent?.id ?? null,
        },
        select: {
          id: true,
          name: true,
          isActive: true,
          parentId: true,
          referralCode: true,
          createdAt: true,
        },
      });

      // Inisialisasi saldo
      await tx.saldo.upsert({
        where: { resellerId: reseller.id },
        update: {},
        create: { resellerId: reseller.id, amount: BigInt(0) },
      });

      // Kredit saldo awal + mutasi (jika ada)
      if (initialSaldo > 0) {
        await tx.saldo.update({
          where: { resellerId: reseller.id },
          data: { amount: { increment: BigInt(initialSaldo) } },
        });

        await tx.mutasiSaldo.create({
          data: {
            resellerId: reseller.id,
            trxId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
            amount: BigInt(initialSaldo),
            type: "CREDIT",
            note: "Saldo awal reseller (by admin)",
            metadata: {},
            source: "Saldo awal reseller (by admin)"
          },
        });
      }

      // Bind device phone
      await tx.device.create({
        data: { resellerId: reseller.id, type: "PHONE", identifier: phone, isActive: true },
      });

      // Ambil saldo akhir
      const saldo = await tx.saldo.findUnique({
        where: { resellerId: reseller.id },
        select: { amount: true },
      });

      return {
        reseller,
        saldo: Number(saldo?.amount ?? 0n),
        plainApiKey,
        tempPassword: password ? undefined : tempPassword, // hanya tampil jika auto generate
        username,
      };
    });

    return res.status(201).json({
      message: "Reseller berhasil dibuat oleh admin.",
      data: result,
    });
  } catch (err) {
    if (err.message === "USERNAME_TAKEN")     return res.status(409).json({ error: "Username sudah digunakan." });
    if (err.message === "PHONE_TAKEN")        return res.status(409).json({ error: "Nomor HP sudah terdaftar." });
    if (err.message === "REFERRER_NOT_FOUND") return res.status(404).json({ error: "Kode referral tidak ditemukan." });
    if (err.message === "PARENT_NOT_FOUND")   return res.status(404).json({ error: "Parent reseller tidak ditemukan." });
    if (err.code === "P2002") {
      const fields = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : "field unik";
      return res.status(409).json({ error: `Data duplikat pada ${fields}.` });
    }
    console.error("createResellerByAdmin error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
