// api/middleware/authAdmin.js
import jwt from "jsonwebtoken";
import prisma from "../prisma.js";

/**
 * Ambil token dari:
 * - Authorization: Bearer <token>
 * - Cookie httpOnly bernama "token"
 */
function getTokenFromReq(req) {
  const h = req.headers?.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  // butuh cookie-parser di app: app.use(require('cookie-parser')())
  if (req.cookies?.token) return req.cookies.token;
  return null;
}

/**
 * Middleware: hanya ADMIN yang lolos
 * - Verifikasi JWT (SECRET di env JWT_SECRET)
 * - Ambil user dari DB, cek role === 'ADMIN' & isActive
 * - Set req.admin = { id, username }
 */
export async function authAdmin(req, res, next) {
  try {
    const token = getTokenFromReq(req);
    if (!token) return res.status(401).json({ error: "Token tidak ditemukan." });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: "Token tidak valid / kedaluwarsa." });
    }

    // Ambil user dari DB
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, username: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: "User tidak ditemukan / nonaktif." });
    }
    if (user.role !== "admin" && user.role !== "ADMIN") {
      return res.status(403).json({ error: "Akses admin diperlukan." });
    }

    req.admin = { id: user.id, username: user.username };
    next();
  } catch (err) {
    console.error("authAdmin error:", err);
    res.status(500).json({ error: "Auth internal error." });
  }
}
