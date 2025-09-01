import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { readSession, rotateSession, deleteSession } from "../lib/session.js";
import { setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE } from "../../utils/refreshCookie.js";
import { signAccessToken } from "../../utils/jwt.js";
import { createSession } from "../lib/session.js";

const normalizePhone = (s="") => s.replace(/[^\d]/g,''); // keep digits only
const REFRESH_TTL_SEC =
  parseInt(process.env.REFRESH_TTL_SEC || "", 10) || 30 * 24 * 3600; // 30d

const prisma = new PrismaClient();
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";
const JWT_SECRET = process.env.JWT_SECRET || "change-this";
const COOKIE_NAME = process.env.COOKIE_NAME || "token";
const JWT_ISS = process.env.JWT_ISS || "serverpulsa";
const JWT_AUD = process.env.JWT_AUD || "serverpulsa-admin";
// function setAuthCookie(res, token) {
//   // HttpOnly cookie (aman untuk Next.js)
//   res.cookie(COOKIE_NAME, token, {
//     httpOnly: true,
//     sameSite: "lax",
//     secure: false, // set true kalau pakai HTTPS
//     maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
//     path: "/",
//   });
// }

// utils/cookie.js
export function setAuthCookie(res, token, maxAgeLikeJwt) {
  // parse `12h`, `7d`, dll → detik (fallback 12 jam)
  const toSeconds = (v) => {
    if (!v) return 12 * 60 * 60;
    if (/^\d+$/.test(v)) return parseInt(v, 10);
    const m = String(v).match(/^(\d+)([smhd])$/i);
    if (!m) return 12 * 60 * 60;
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    return u === "s"
      ? n
      : u === "m"
      ? n * 60
      : u === "h"
      ? n * 3600
      : n * 86400;
  };

  const maxAge = toSeconds(maxAgeLikeJwt);
  const COOKIE_NAME = process.env.COOKIE_NAME || "token";
  const isProd = process.env.NODE_ENV === "production";

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd, // pastikan true di produksi/HTTPS
    sameSite: "strict",
    path: "/",
    maxAge: maxAge * 1000, // ms
  });
}
export async function loginReseller(req, res) {
  try {
    // fleksibel: login dari 'login' | 'username' | 'phone' | 'phonenumber'
    const rawLogin =
      String(
        req.body?.login ??
        req.body?.username ??
        req.body?.phone ??
        req.body?.phonenumber ??
        ""
      ).trim();

    const password = String(req.body?.password || "");
    if (!rawLogin || !password) {
      return res
        .status(400)
        .json({ error: "Login (username/HP) dan password wajib diisi." });
    }

    // deteksi apakah ini input nomor HP (>=8 digit)
    const justDigits = rawLogin.replace(/[^\d]/g, "");
    const isPhoneLike = justDigits.length >= 8 && /^[0-9]+$/.test(justDigits);

    let user = null;
    let reseller = null;

    if (isPhoneLike) {
      // === LOGIN VIA NOMOR HP ===
      const phone = typeof normalizePhone === "function"
        ? normalizePhone(rawLogin)
        : justDigits; // fallback sederhana kalau belum import normalizePhone

      const device = await prisma.device.findUnique({
        where: { identifier: phone },
        select: {
          isActive: true,
          reseller: {
            select: {
              id: true,
              name: true,
              isActive: true,
              user: { select: { id: true, username: true, password: true, role: true, tokenVersion: true  } },
            },
          },
        },
      });

      if (!device || !device.reseller || !device.reseller.user) {
        // jangan bocorkan mana yang salah (anti enumeration)
        await new Promise((r) => setTimeout(r, 150));
        return res.status(401).json({ error: "Login atau password salah." });
      }

      // (opsional) jika ingin wajib device aktif
      // if (!device.isActive) return res.status(403).json({ error: "Device non-aktif." });

      user = device.reseller.user;
      reseller = { id: device.reseller.id, name: device.reseller.name, isActive: device.reseller.isActive };
    } else {
      // === LOGIN VIA USERNAME ===
      user = await prisma.user.findUnique({
        where: { username: rawLogin },
        select: { id: true, username: true, password: true, role: true, tokenVersion: true  },
      });
      if (!user) {
        await new Promise((r) => setTimeout(r, 150));
        return res.status(401).json({ error: "Login atau password salah." });
      }

      reseller = await prisma.reseller.findUnique({
        where: { userId: user.id },
        select: { id: true, name: true, isActive: true },
      });
      if (!reseller) {
        return res.status(404).json({ error: "Reseller tidak ditemukan." });
      }
    }

    // role harus RESELLER
    if (user.role !== "RESELLER") {
      return res.status(403).json({ error: "Bukan akun reseller." });
    }

    // reseller harus aktif
    if (!reseller.isActive) {
      return res.status(403).json({ error: "Akun reseller non-aktif." });
    }

    // cek password
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      await new Promise((r) => setTimeout(r, 150));
      return res.status(401).json({ error: "Login atau password salah." });
    }

    // === ACCESS + REFRESH ===
    const accessToken = signAccessToken(
      {
        id: user.id,
        role: "RESELLER",
        // ver: user.tokenVersion ?? 1   // aktifkan kalau sudah ada kolom tokenVersion
      },
      { rid: reseller.id } // penting agar req.user.resellerId tersedia di middleware/handler
    );

    const sid = await createSession(
      user.id,
      { ua: req.get("user-agent") || "", ip: (req.ip || "") + "" },
      REFRESH_TTL_SEC
    );
    setRefreshCookie(res, sid, REFRESH_TTL_SEC);

    return res.json({
      message: "Login berhasil.",
      user: { id: user.id, username: user.username, role: "RESELLER" },
      reseller,
      accessToken, // FE kirim via Authorization: Bearer
    });
  } catch (e) {
    console.error("loginReseller (phone/username):", e);
    return res.status(500).json({ error: "Gagal login." });
  }
}

export async function loginAdmin(req, res) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: "Username dan password wajib." });

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user)
      return res.status(401).json({ error: "Username atau password salah." });
    if (user.role !== "ADMIN")
      return res.status(403).json({ error: "Bukan akun ADMIN." });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(401).json({ error: "Username atau password salah." });

    // === ACCESS + REFRESH ===
    const accessToken = signAccessToken({
      id: user.id,
      role: "ADMIN",
      ver: user.tokenVersion ?? 1,
    });
    const sid = await createSession(
      user.id,
      { ua: req.get("user-agent") || "", ip: (req.ip || "") + "" },
      REFRESH_TTL_SEC
    );
    setRefreshCookie(res, sid, REFRESH_TTL_SEC);

    // setAccessCookie(res, accessToken);

    return res.json({
      message: "Login berhasil.",
      user: { id: user.id, username: user.username, role: user.role },
      accessToken,
    });
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ error: "Gagal login." });
  }
}

export async function me(req, res) {
  try {
    const { id, resellerId } = req.user || {};
    if (!id) return res.status(401).json({ error: "Unauthorized" });

    const [
      user,
      reseller,
      saldo,
      // --- POINS ---
      resellerPoint, // saldo poin saat ini
      earnedAgg, // total poin yang pernah diberikan
      redeemedAgg, // total poin yang pernah ditebus (APPROVED)
      pendingRedeemAgg, // total poin yang sedang diajukan (PENDING)
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id },
        select: { id: true, username: true, role: true, createdAt: true },
      }),
      prisma.reseller.findUnique({
        where: { id: resellerId },
        select: { id: true, name: true, referralCode: true, isActive: true },
      }),
      prisma.saldo
        ?.findUnique?.({
          where: { resellerId },
          select: { amount: true },
        })
        .catch(() => null),

      prisma.resellerPoint.findUnique({
        where: { resellerId },
        select: { balance: true },
      }),

      prisma.transactionPoint.aggregate({
        where: { resellerId },
        _sum: { points: true },
      }),

      prisma.pointRedemption.aggregate({
        where: { resellerId, status: "APPROVED" }, // atau RedeemStatus.APPROVED
        _sum: { points: true },
      }),

      prisma.pointRedemption.aggregate({
        where: { resellerId, status: "PENDING" }, // atau RedeemStatus.PENDING
        _sum: { points: true },
      }),
    ]);

    const points = {
      balance: resellerPoint?.balance ?? 0,
      earnedTotal: earnedAgg?._sum?.points ?? 0,
      redeemedTotal: redeemedAgg?._sum?.points ?? 0,
      pendingRedeem: pendingRedeemAgg?._sum?.points ?? 0,
    };

    return res.json({
      user,
      reseller,
      saldo: saldo || { amount: 0n }, // tetap bigInt sesuai skema kamu
      points,
    });
  } catch (e) {
    console.error("me:", e);
    return res.status(500).json({ error: "Gagal mengambil profil." });
  }
}

export async function logout(req, res) {
  try {
    const sid = req.cookies?.[REFRESH_COOKIE];
    if (sid) {
      const sess = await readSession(sid);
      if (sess?.userId) await deleteSession(sid, sess.userId);
    }
    clearRefreshCookie(res);                 // hapus cookie refresh
    res.clearCookie(COOKIE_NAME, { path: "/" }); // kalau dulu sempat pakai access cookie

    return res.json({ message: "Logout berhasil." });
  } catch (e) {
    return res.status(500).json({ error: "Gagal logout." });
  }
}



export async function refresh(req, res) {
  try {
    const sid = req.cookies?.[REFRESH_COOKIE];
    if (!sid) return res.status(401).json({ error: "No refresh" });

    const sess = await readSession(sid);
    if (!sess) return res.status(401).json({ error: "Invalid refresh" });

    // Ambil state user terbaru
    const user = await prisma.user.findUnique({
      where: { id: sess.userId },
      select: { id: true, role: true, tokenVersion: true,  },
    });
    if (!user ) {
      return res.status(401).json({ error: "Invalid refresh" });
    }

    // ROTATE sid → set cookie baru
    const newSid = await rotateSession(
      sid,
      user.id,
      { ua: req.get("user-agent") || "", ip: (req.ip || "") + "" },
      REFRESH_TTL_SEC
    );
    setRefreshCookie(res, newSid, REFRESH_TTL_SEC);

    // (opsional) tambahkan resellerId (rid) ke access token
    let extra = {};
    if (user.role === "RESELLER") {
      const r = await prisma.reseller.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (r?.id) extra = { rid: r.id };
    }

    const accessToken = signAccessToken(
      { id: user.id, role: user.role, ver: user.tokenVersion ?? 1 },
      extra
    );

    return res.json({ accessToken });
  } catch (e) {
    console.error("refresh error:", e);
    return res.status(500).json({ error: "Gagal refresh." });
  }
}
