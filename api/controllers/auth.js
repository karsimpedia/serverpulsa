import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const COOKIE_NAME = process.env.COOKIE_NAME || "token";
const JWT_SECRET  = process.env.JWT_SECRET || "change-this";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";

function setAuthCookie(res, token) {
  // HttpOnly cookie (aman untuk Next.js)
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // set true kalau pakai HTTPS
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
    path: "/",
  });
}

export async function loginReseller(req, res) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: "Username dan password wajib." });

    // cari user
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ error: "Username atau password salah." });
    if (user.role !== "RESELLER")
      return res.status(403).json({ error: "Bukan akun reseller." });

    // cek password
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Username atau password salah." });

    // ambil reseller
    const reseller = await prisma.reseller.findUnique({
      where: { userId: user.id },
      select: { id: true, name: true, isActive: true },
    });
    if (!reseller) return res.status(404).json({ error: "Reseller tidak ditemukan." });
    if (!reseller.isActive) return res.status(403).json({ error: "Akun reseller non-aktif." });

    // buat token
    const payload = { id: user.id, role: user.role, resellerId: reseller.id };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    setAuthCookie(res, token);
    return res.json({
      message: "Login berhasil.",
      user: { id: user.id, username: user.username, role: user.role },
      reseller,
      token, // kalau mau purely cookie-based, boleh dihapus dari body
    });
  } catch (e) {
    console.error("loginReseller:", e);
    return res.status(500).json({ error: "Gagal login." });
  }
}

export async function me(req, res) {
  try {
    // req.user dari middleware
    const { id, resellerId } = req.user || {};
    if (!id) return res.status(401).json({ error: "Unauthorized" });

    const [user, reseller, saldo] = await Promise.all([
      prisma.user.findUnique({ where: { id }, select: { id: true, username: true, role: true, createdAt: true } }),
      prisma.reseller.findUnique({ where: { id: resellerId }, select: { id: true, name: true, referralCode: true, isActive: true } }),
      prisma.saldo?.findUnique?.({ where: { resellerId }, select: { amount: true } }).catch(() => null),
    ]);

    return res.json({ user, reseller, saldo: saldo || { amount: 0 } });
  } catch (e) {
    console.error("me:", e);
    return res.status(500).json({ error: "Gagal mengambil profil." });
  }
}

export async function logout(req, res) {
  try {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    return res.json({ message: "Logout berhasil." });
  } catch (e) {
    return res.status(500).json({ error: "Gagal logout." });
  }
}
