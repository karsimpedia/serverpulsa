// api/middleware/auth.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-this";
const COOKIE_NAME = process.env.COOKIE_NAME || "token";

// Ambil token dari Cookie atau Authorization: Bearer
function getToken(req) {
  const fromCookie = req.cookies?.[COOKIE_NAME];
  if (fromCookie) return fromCookie;

  const h = req.get("authorization") || req.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// Opsional: isi req.user jika token ada & valid, tapi tidak memblokir
export function authOptional(req, _res, next) {
  const t = getToken(req);
  if (!t) return next();
  try {
    req.user = jwt.verify(t, JWT_SECRET); // { id, role, resellerId? }
  } catch {}
  return next();
}

// Wajib login (role apa saja)
export function authRequired(req, res, next) {
  const t = getToken(req);
  if (!t) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(t, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Hanya ADMIN
export function authAdmin(req, res, next) {
  const t = getToken(req);
  if (!t) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(t, JWT_SECRET);
   
    if (req.user?.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden (ADMIN only)" });
    }
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Hanya RESELLER
export function authReseller(req, res, next) {
  const t = getToken(req);
  if (!t) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(t, JWT_SECRET);
     console.log(req.user)
    if (req.user?.role !== "RESELLER") {
      return res.status(403).json({ error: "Forbidden (RESELLER only)" });
    }
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Kustom: salah satu dari beberapa role
export function requireRole(...roles) {
  return (req, res, next) => {
    const t = getToken(req);
    if (!t) return res.status(401).json({ error: "Unauthorized" });
    try {
      req.user = jwt.verify(t, JWT_SECRET);
      if (!roles.includes(req.user?.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}
