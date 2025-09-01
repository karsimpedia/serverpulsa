// api/middleware/auth.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-this";
const COOKIE_NAME = process.env.COOKIE_NAME || "token";
const JWT_ISS = process.env.JWT_ISS || "serverpulsa";
const JWT_AUD = process.env.JWT_AUD || "serverpulsa-admin";

function getToken(req) {
  const fromCookie = req.cookies?.[COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const h = req.get("authorization") || req.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// helper verifikasi konsisten
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { issuer: JWT_ISS, audience: JWT_AUD });
}

// --- Middleware ---
export function authOptional(req, _res, next) {
  const t = getToken(req);
  if (!t) return next();
  try { req.user = verifyToken(t); } catch {}
  return next();
}

export function authRequired(req, res, next) {
  const t = getToken(req);
  if (!t) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = verifyToken(t);
    return next();
  } catch (e) {
    console.error("authRequired verify error:", e?.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function authAdmin(req, res, next) {
  const t = getToken(req);
  if (!t) return res.status(401).json({ error: "Unauthorized" });
  try {
    const claims = verifyToken(t);
    if (claims.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden (ADMIN only)" });
    }
    req.user = { id: claims.sub, role: claims.role, jti: claims.jti, ver: claims.ver };
    return next();
  } catch (e) {
    console.error("authAdmin verify error:", e?.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function authReseller(req, res, next) {
  const t = getToken(req);
  if (!t) return res.status(401).json({ error: "Unauthorized" });
  try {
    const claims = verifyToken(t);
    if (claims.role !== "RESELLER") {
      return res.status(403).json({ error: "Forbidden (RESELLER only)" });
    }
    req.user = claims;
    return next();
  } catch (e) {
    console.error("authReseller verify error:", e?.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    const t = getToken(req);
    if (!t) return res.status(401).json({ error: "Unauthorized" });
    try {
      const claims = verifyToken(t);
      if (!roles.includes(claims.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      req.user = claims;
      return next();
    } catch (e) {
      console.error("requireRole verify error:", e?.message);
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}
