// utils/jwt.js
import jwt from "jsonwebtoken";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || "change-this";
const JWT_ISS = process.env.JWT_ISS || "serverpulsa";
const JWT_AUD = process.env.JWT_AUD || "serverpulsa-admin";
export const ACCESS_TTL_SEC = parseInt(process.env.ACCESS_TTL_SEC || "", 10) || 15 * 60; // 15m

export function signAccessToken(user, extra = {}) {
  const jti = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");

  const payload = { sub: user.id, role: user.role, ver: user.ver ?? 1, ...extra };

  return jwt.sign(payload, JWT_SECRET, {
    issuer: JWT_ISS,
    audience: JWT_AUD,
    jwtid: jti,
    expiresIn: ACCESS_TTL_SEC,
    algorithm: "HS256", // ✅ gunakan 'algorithm' (string)
  });
}
