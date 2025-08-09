// api/middleware/authReseller.js
import bcrypt from "bcrypt";
import prisma from "../prisma.js";

export default async function authReseller(req, res, next) {
  try {
    const apiKey =
      req.header("x-api-key") ||
      req.query.api_key ||
      req.body.apiKey;

    const resellerId =
      req.header("x-reseller-id") ||
      req.query.reseller_id ||
      req.body.resellerId;

    if (!apiKey || !resellerId) {
      return res.status(401).json({ error: "x-api-key dan x-reseller-id wajib." });
    }

    // Ambil reseller by ID (unik), lalu cek aktif
    const reseller = await prisma.reseller.findUnique({
      where: { id: resellerId },
      select: { id: true, name: true, apiKeyHash: true, isActive: true },
    });

    if (!reseller || !reseller.isActive) {
      return res.status(401).json({ error: "Reseller tidak ditemukan / nonaktif." });
    }

    // Compare API key dengan hash
    const match = await bcrypt.compare(apiKey, reseller.apiKeyHash);
    if (!match) {
      return res.status(401).json({ error: "API key tidak valid." });
    }

    // inject context
    req.reseller = { id: reseller.id, name: reseller.name };
    next();
  } catch (e) {
    console.error("authReseller error:", e);
    return res.status(500).json({ error: "Auth internal error." });
  }
}
