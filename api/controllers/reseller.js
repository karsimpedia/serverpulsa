// api/controllers/reseller.js
import prisma from "../prisma.js";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { generateResellerId } from "../../utils/idGenerator.js";

// GET saldo reseller login
export async function getSaldo(req, res) {
  console.log(req.params.id);
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
      return res
        .status(401)
        .json({ error: "Unauthorized (resellerId tidak ada)" });
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "20", 10), 1),
      200
    );
    const skip = (page - 1) * limit;

    const { status, msisdn, idOrInvoice, q } = req.query;

    const where = { resellerId };
    if (status) where.status = String(status).toUpperCase();
    if (msisdn) where.msisdn = { contains: msisdn, mode: "insensitive" };
    if (idOrInvoice) {
      where.OR = [{ id: idOrInvoice }, { invoiceId: idOrInvoice }];
    }
    if (q) {
      where.OR = [
        { msisdn: { contains: q, mode: "insensitive" } },
        { invoiceId: { contains: q, mode: "insensitive" } },
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
        },
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
  const id = req.params.id;
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
  const id = req.user.resellerId;
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
    const { url, secret, isActive } = req.body || req.query
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

const normalizePhone = (s = "") => s.replace(/[^\d]/g, ""); // keep digits only
const normalizeCode = (s = "") => s.trim().toUpperCase().replace(/\s+/g, "");
async function ensureResellerSeq(tx) {
  // Buat sequence jika belum ada
  await tx.$executeRawUnsafe(
    `CREATE SEQUENCE IF NOT EXISTS public.reseller_seq START 1`
  );

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
    const {
      name,
      username,
      password,
      referralCode,
      pin,
      phonenumber,
      address,
    } = req.body;
    if (!name || !username || !password || !phonenumber) {
      return res
        .status(400)
        .json({
          error: "Name, username, password, dan phone number wajib diisi.",
        });
    }
    const phone = normalizePhone(phonenumber);
    if (phone.length < 8)
      return res.status(400).json({ error: "Nomor HP tidak valid." });

    const result = await prisma.$transaction(async (tx) => {
      let reseller; // <-- deklarasi di atas
      const plainApiKey = randomBytes(32).toString("hex");

      console.log(plainApiKey); // 64 karakter hex
      const apiKeyHash = await bcrypt.hash(plainApiKey, 10); // simpan di DB
      // username unik
      const existingUser = await tx.user.findUnique({ where: { username } });
      if (existingUser) throw new Error("USERNAME_TAKEN");

      // referrer (opsional)
      let parent = null;
      if (referralCode) {
        const codeRef = normalizeCode(referralCode);
        parent = await tx.reseller.findUnique({
          where: { referralCode: codeRef },
        });
        if (!parent) throw new Error("REFERRER_NOT_FOUND");
      }

      // phone unik
      const existingPhone = await tx.device.findUnique({
        where: { identifier: phone },
      });
      if (existingPhone) throw new Error("PHONE_TAKEN");

      // hash
      const hashedPassword = await bcrypt.hash(password, 10);
      const pinHashed = await bcrypt.hash(pin || "123456", 10);

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
          address,
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
        data: {
          resellerId: reseller.id,
          type: "PHONE",
          identifier: phone,
          isActive: true,
        },
      });

      return reseller;
    });

    res
      .status(201)
      .json({ message: "Reseller berhasil didaftarkan.", reseller: result });
  } catch (err) {
    if (err.message === "USERNAME_TAKEN")
      return res.status(409).json({ error: "Username sudah digunakan." });
    if (err.message === "REFERRER_NOT_FOUND")
      return res.status(404).json({ error: "Kode referral tidak ditemukan." });
    if (err.message === "PHONE_TAKEN")
      return res.status(409).json({ error: "No HP sudah terdaftar." });
    if (err.code === "P2002") {
      const fields = Array.isArray(err.meta?.target)
        ? err.meta.target.join(", ")
        : "field unik";
      return res.status(409).json({ error: `Data duplikat pada ${fields}.` });
    }
    console.error("Register reseller error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

export async function getReseller(req, res) {
  try {
    const { id } = req.params;
    const item = await prisma.reseller.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        isActive: true,
        address: true,
        referralCode: true,
        parentId: true,
        createdAt: true,
        updatedAt: true,
        saldo: { select: { amount: true } }, // kalau memang ada di Reseller
        devices: {
          where: { type: "PHONE" },
          select: {
            id: true,
            type: true,
            identifier: true,
            isActive: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!item)
      return res.status(404).json({ error: "Reseller tidak ditemukan." });
    const saldo = item.saldo.amount;
    // Primary phone (opsional): ambil device phone pertama yang aktif, kalau ada
    const primaryPhone =
      item.devices.find((d) => d.isActive)?.identifier ??
      item.devices[0]?.identifier ??
      null;

    res.json({ data: { ...item, primaryPhone, saldo } });
  } catch (e) {
    res.status(500).json({ error: "Gagal mengambil data reseller." });
  }
}
// List all resellers with search & pagination

export async function resellerList(req, res) {
  try {
    const qRaw = String(req.query?.q ?? "").trim();
    const qDigits = qRaw.replace(/[^\d+]/g, "");
    const isActiveParam = String(req.query?.isActive ?? "");
    const page = Math.max(parseInt(String(req.query?.page ?? "1"), 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(String(req.query?.limit ?? "20"), 10) || 20, 1), 200);
    const skip = (page - 1) * limit;

    const activeClause =
      isActiveParam === "true" ? { isActive: true } :
      isActiveParam === "false" ? { isActive: false } : {};

    const where = {
      ...activeClause,
      ...(qRaw
        ? {
            OR: [
              { id: { contains: qRaw, mode: "insensitive" } },
              { name: { contains: qRaw, mode: "insensitive" } },
              ...(qDigits
                ? [{ devices: { some: { /* type: "phone", */ identifier: { contains: qDigits } } } }]
                : []),
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.reseller.findMany({
        where,
        select: {
          id: true, name: true, isActive: true, parentId: true,
          createdAt: true, updatedAt: true,
          saldo: { select: { amount: true } },
        },
        orderBy: { createdAt: "desc" },
        skip, take: limit,
      }),
      prisma.reseller.count({ where }),
    ]);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        isActive: r.isActive,
        parentId: r.parentId,
        saldo: r.saldo ? Number(r.saldo.amount) : 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      page, limit, total,
    });
  } catch (err) {
    console.error("Fetch resellers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}


//DELETE /api/reseller/:id/devices/:deviceId
export async function deleteDevice(req, res) {
  try {
    const { id, deviceId } = req.params;

    // (opsional) cek kepemilikan
    const owner = await prisma.device.findUnique({
      where: { id: deviceId },
      select: { resellerId: true },
    });
    if (!owner)
      return res.status(404).json({ error: "Device tidak ditemukan." });
    if (owner.resellerId !== id)
      return res
        .status(403)
        .json({ error: "Tidak boleh menghapus device milik reseller lain." });

    await prisma.device.delete({ where: { id: deviceId } });
    res.json({ data: { id: deviceId } });
  } catch (e) {
    if (e.code === "P2025")
      return res.status(404).json({ error: "Device tidak ditemukan." });
    res.status(400).json({ error: e?.message || "Gagal menghapus device." });
  }
}

//PATCH /api/reseller/:id/devices/:deviceId — edit nomor / aktif

export async function updateDevice(req, res) {
  try {
    const { id, deviceId } = req.params;
    const { identifier, isActive } = req.body || {};

    const data = {};
    if (identifier !== undefined) {
      const next = normalizePhone(identifier);
      if (!next)
        return res.status(400).json({ error: "identifier tidak valid." });

      const dup = await prisma.device.findUnique({
        where: { identifier: next },
        select: { id: true, resellerId: true },
      });
      if (dup && dup.id !== deviceId)
        return res.status(409).json({ error: "PHONE_TAKEN" });

      data.identifier = next;
    }
    if (typeof isActive === "boolean") data.isActive = isActive;

    // (opsional) pastikan device milik reseller ybs
    const owner = await prisma.device.findUnique({
      where: { id: deviceId },
      select: { resellerId: true },
    });
    if (!owner)
      return res.status(404).json({ error: "Device tidak ditemukan." });
    if (owner.resellerId !== id)
      return res
        .status(403)
        .json({ error: "Tidak boleh mengubah device milik reseller lain." });

    const updated = await prisma.device.update({
      where: { id: deviceId },
      data,
      select: { id: true, identifier: true, isActive: true, type: true },
    });
    res.json({ data: updated });
  } catch (e) {
    if (e.code === "P2025")
      return res.status(404).json({ error: "Device tidak ditemukan." });
    res.status(400).json({ error: e?.message || "Gagal memperbarui device." });
  }
}

//POST /api/reseller/:id/devices — tambah nomor
export async function addDevice(req, res) {
  try {
    const { id } = req.params;
    const identifier = normalizePhone(req.body?.identifier);
    const type = req.body?.type || "phone";
    const isActive = req.body?.isActive ?? true;

    if (!identifier)
      return res.status(400).json({ error: "identifier wajib." });

    // global unique → findUnique by identifier
    const dup = await prisma.device.findUnique({ where: { identifier } });
    if (dup) return res.status(409).json({ error: "PHONE_TAKEN" });

    const dev = await prisma.device.create({
      data: { resellerId: id, type, identifier, isActive },
      select: { id: true, identifier: true, isActive: true, type: true },
    });
    res.json({ data: dev });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Gagal menambah device." });
  }
}

// Update reseller

export async function updateReseller(req, res) {
  try {
    const { id } = req.params;
    const { name, address, referralCode, parentId, isActive } = req.body || {};

    // validasi parentId (opsional, tapi bagus punya)
    if (parentId && parentId === id) {
      return res
        .status(400)
        .json({ error: "parentId tidak boleh sama dengan id reseller." });
    }

    const data = {};
    if (name != null) data.name = String(name).trim();
    if (address !== undefined)
      data.address = address ? String(address).trim() : null;
    if (referralCode !== undefined)
      data.referralCode = referralCode ? String(referralCode).trim() : null;
    if (parentId !== undefined)
      data.parentId = parentId ? String(parentId).trim().toUpperCase() : null;
    if (typeof isActive === "boolean") data.isActive = isActive;

    // (opsional) cek parentId ada
    if (data.parentId) {
      const cekParent = await prisma.reseller.findUnique({
        where: { id: data.parentId },
        select: { id: true },
      });
      if (!cekParent)
        return res.status(400).json({ error: "parentId tidak valid." });
    }

    await prisma.reseller.update({ where: { id }, data });
    res.json({ data: { id } });
  } catch (e) {
    if (e.code === "P2025")
      return res.status(404).json({ error: "Reseller tidak ditemukan." });
    res
      .status(400)
      .json({ error: e?.message || "Gagal memperbarui reseller." });
  }
}

// export async function updateReseller(req, res) {
//   try {
//     const { id } = req.params;
//     const { name, password, pin, address, parentId, isActive } = req.body;

//     const existing = await prisma.reseller.findUnique({ where: { id } });
//     if (!existing)
//       return res.status(404).json({ error: "Reseller tidak ditemukan" });

//     const data = {};
//     if (name) data.name = name;
//     if (address) data.address = address;
//     if (isActive !== undefined) data.isActive = !!isActive;

//     // Update password di tabel User
//     if (password) {
//       const hashedPassword = await bcrypt.hash(password, 10);
//       await prisma.user.update({
//         where: { id: existing.userId },
//         data: { password: hashedPassword },
//       });
//     }

//     // Update pin di tabel Reseller
//     if (pin) {
//       if (!/^\d{6}$/.test(pin)) {
//         return res
//           .status(400)
//           .json({ error: "PIN harus berupa 6 digit angka" });
//       }
//       data.pin = await bcrypt.hash(pin, 10);
//     }

//     if (parentId !== undefined) {
//       if (parentId) {
//         const parent = await prisma.reseller.findUnique({
//           where: { id: parentId },
//         });
//         if (!parent)
//           return res.status(400).json({ error: "Upline tidak valid" });
//         data.parentId = parentId;
//       } else {
//         data.parentId = null;
//       }
//     }

//     const updated = await prisma.reseller.update({ where: { id }, data });
//     res.json({ message: "Reseller berhasil diperbarui", reseller: updated });
//   } catch (err) {
//     console.error("Update reseller error:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// }

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
    if (!meId)
      return res
        .status(401)
        .json({ error: "Unauthorized (resellerId tidak ada)" });

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
      markup: d.ResellerGlobalMarkup?.[0]?.markup ?? 0n,
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
