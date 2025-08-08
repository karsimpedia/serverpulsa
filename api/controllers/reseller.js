// api/controllers/reseller.js
import prisma from "../prisma.js";
import bcrypt from "bcrypt";
import { generateResellerId } from "../../utils/idGenerator.js";

// GET saldo reseller login
export async function getSaldo(req, res) {
  try {
    const saldo = await prisma.saldo.findUnique({
      where: { resellerId: req.reseller.id },
    });
    res.json({ amount: Number(saldo?.amount ?? 0n) });
  } catch (err) {
    console.error("Get saldo error:", err);
    res.status(500).json({ error: "Gagal mengambil saldo" });
  }
}

// GET mutasi saldo reseller login
export async function getMutasi(req, res) {
  try {
    const take = Number(req.query.take || 20);
    const skip = Number(req.query.skip || 0);
    const rows = await prisma.mutasiSaldo.findMany({
      where: { resellerId: req.reseller.id },
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
function normalizeCode(s) {
  return String(s || "").trim().toUpperCase();
}

export const registerReseller = async (req, res) => {
  try {
    const { name, username, password, referralCode } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({ error: "Name, username, dan password wajib diisi." });
    }

    // Cek username unik
    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) {
      return res.status(409).json({ error: "Username sudah digunakan." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Buat user dulu
    const user = await prisma.user.create({
      data: {
        username,
        password: hashedPassword,
        role: "RESELLER"
      }
    });

    // Normalisasi kode referral
    let finalReferral = referralCode ? normalizeCode(referralCode) : null;

    // Cek kode referral kalau user input manual
    if (finalReferral) {
      const existingRef = await prisma.reseller.findUnique({
        where: { referralCode: finalReferral }
      });
      if (existingRef) {
        return res.status(409).json({ error: "Kode referral sudah digunakan reseller lain." });
      }
    }

    // Buat reseller (kalau referral tidak diisi, nanti di-update setelah create)
    let reseller = await prisma.reseller.create({
      data: {
        userId: user.id,
        name,
        apiKeyHash: "", // bisa diisi nanti
        isActive: true,
        referralCode: finalReferral || "" // isi kosong dulu kalau belum ada
      }
    });

    // Kalau referralCode belum diisi, pakai id reseller
    if (!finalReferral) {
      const autoCode = normalizeCode(reseller.id);
      await prisma.reseller.update({
        where: { id: reseller.id },
        data: { referralCode: autoCode }
      });
      reseller.referralCode = autoCode;
    }

    res.status(201).json({
      message: "Reseller berhasil didaftarkan.",
      reseller
    });
  } catch (err) {
    console.error("Register reseller error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

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
