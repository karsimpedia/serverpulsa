// api/controllers/callback.js
import crypto from "crypto";
import prisma from "../prisma.js";
import { finalizeFailed, finalizeSuccess } from "../lib/finalize.js";

const FINAL_STATES = new Set(["SUCCESS", "FAILED", "REFUNDED", "CANCELED", "EXPIRED"]);

// ===== Helpers =====
function pick(obj, path, fallback) {
  if (!path) return fallback;
  const segs = String(path).split(".").filter(Boolean);
  let cur = obj;
  for (const k of segs) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, k)) cur = cur[k];
    else return fallback;
  }
  return cur ?? fallback;
}

function parseAmountToInt(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  const s = String(v).trim();
  if (!s) return null;
  const normalized = s
    .replace(/[^\d.,-]/g, "")
    .replace(/,/g, ".")
    .replace(/(\..*)\./g, "$1");
  const num = Number(normalized);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
}

function verifySignature(req, secret, headerName = "x-signature", algo = "sha256") {
  if (!secret) return true;
  try {
    const sig =
      req.headers[headerName] ||
      req.headers[headerName.toLowerCase()] ||
      "";
    const bodyRaw = req.rawBody || JSON.stringify(req.body || {});
    const hmac = crypto.createHmac(algo, secret).update(bodyRaw).digest("hex");
    return sig === hmac;
  } catch {
    return false;
  }
}

function normStatus(raw, aliasMap) {
  const s = String(raw ?? "").trim().toUpperCase();
  const mapped = (aliasMap && aliasMap[s]) || s;
  if (["OK","SUCCESS","SUKSES","DONE","COMPLETED"].includes(mapped)) return "SUCCESS";
  if (["FAIL","FAILED","ERROR"].includes(mapped)) return "FAILED";
  if (["CANCEL","CANCELED","CANCELLED"].includes(mapped)) return "CANCELED";
  if (["EXPIRE","EXPIRED","TIMEOUT"].includes(mapped)) return "EXPIRED";
  if (["PENDING","PROCESS","PROCESSING","INPROGRESS","WAITING"].includes(mapped)) return "PROCESSING";
  return "PROCESSING";
}

function safeMessage(v, fallback) {
  const s = v == null ? fallback : String(v);
  return s.slice(0, 500);
}

// Ambil config dari SupplierConfig (ops.callback + defaults fallback)
function extractCallbackConfig(configRow) {
  const defaults = configRow?.defaults || {};
  const ops = configRow?.ops || {};
  const cb = ops?.callback || {};

  // dukung define secret/header di defaults.webhook.* bila tidak ada di callback
  const defWebhook = defaults?.webhook || {};
  return {
    refField: cb.refField || "ref",
    statusField: cb.statusField || "status",
    messageField: cb.messageField || "message",
    priceField: cb.priceField || null,
    idMode: cb.idMode || "invoiceId", // "id" | "invoiceId"
    statusAlias: cb.statusAlias || {},
    signatureHeader: cb.signatureHeader || defWebhook.header || "x-signature",
    secret: cb.secret || defWebhook.secret || "",
    sigAlgo: cb.sigAlgo || defWebhook.sigAlgo || "sha256",
  };
}

// ===== Controller utama =====
export async function supplierCallbackUniversal(req, res) {
  try {
    const supplierCode = String(req.params?.supplierCode || "").trim().toUpperCase();
    if (!supplierCode) return res.json({ ok: false, error: "supplierCode missing" });

    // 1) Ambil supplier & config
    const supplier = await prisma.supplier.findFirst({
      where: { code: supplierCode },
      select: { id: true, code: true, name: true },
    });
    if (!supplier) return res.json({ ok: false, error: "supplier not found" });

    const cfgRow = await prisma.supplierConfig.findUnique({
      where: { supplierId: supplier.id },
      select: { id: true, version: true, defaults: true, ops: true, updatedAt: true },
    });
    if (!cfgRow) {
      return res.json({ ok: false, error: "supplier config not found" });
    }
    const cfg = extractCallbackConfig(cfgRow);

    // 2) Ambil ref/status/message/price dari payload sesuai mapping
    const ref     = pick(req.body || {}, cfg.refField,     req.query?.ref || null);
    const status  = pick(req.body || {}, cfg.statusField,  req.query?.status || null);
    const message = pick(req.body || {}, cfg.messageField, req.query?.message || null);
    const priceRaw = cfg.priceField ? pick(req.body || {}, cfg.priceField, null) : null;
    const supplierPrice = parseAmountToInt(priceRaw);

    if (!ref || !status) {
      return res.json({ ok: false, error: "ref & status required" });
    }

    // 3) Verifikasi signature (jika secret diset)
    const signatureOK = verifySignature(req, cfg.secret, cfg.signatureHeader, cfg.sigAlgo);
    if (cfg.secret && !signatureOK) {
      return res.json({ ok: false, error: "invalid signature" });
    }

    // 4) Pastikan transaksi milik supplier ini
    const whereBy =
      cfg.idMode === "id"
        ? { id: String(ref), supplierId: supplier.id }
        : { invoiceId: String(ref), supplierId: supplier.id };

    let trx = await prisma.transaction.findFirst({
      where: whereBy,
      select: { id: true, status: true, supplierId: true, supplierPrice: true },
    });

    if (!trx) {
      // fallback: coba match by id
      trx = await prisma.transaction.findFirst({
        where: { id: String(ref), supplierId: supplier.id },
        select: { id: true, status: true, supplierId: true, supplierPrice: true },
      });
      if (!trx) return res.json({ ok: true, skip: "trx not found for this supplier" });
    }

    const S = normStatus(status, cfg.statusAlias);
    const msg = safeMessage(message, S);
    const supplierResult = {
      supplierCode: supplier.code,
      status: S,
      raw: req.body || {},
      cfgVersion: cfgRow.version,
      refField: cfg.refField,
      statusField: cfg.statusField,
      messageField: cfg.messageField,
      priceField: cfg.priceField,
    };

    // 5) Atomic via transaction
    const acted = await prisma.$transaction(async (tx) => {
      const current = await tx.transaction.findUnique({
        where: { id: trx.id },
        select: { id: true, status: true, supplierPrice: true },
      });
      if (!current) return { done: false, state: null, reason: "trx missing" };
      if (FINAL_STATES.has(current.status)) {
        return { done: false, state: current.status, reason: "already-final" };
      }

      // Update harga beli (supplierPrice) jika ada
      if (supplierPrice != null && supplierPrice !== Number(current.supplierPrice || 0)) {
        await tx.transaction.update({
          where: { id: current.id },
          data: { supplierPrice: BigInt(supplierPrice) },
        });
      }

      if (S === "SUCCESS") {
        await finalizeSuccess(current.id, { message: msg, supplierResult, tx });
        return { done: true, state: "SUCCESS" };
      }

      if (["FAILED", "CANCELED", "EXPIRED"].includes(S)) {
        await finalizeFailed(current.id, { message: msg, supplierResult, tx });
        return { done: true, state: S };
      }

      // PROCESSING / lainnya
      await tx.transaction.update({
        where: { id: current.id },
        data: {
          status: "PROCESSING",
          message: msg,
          supplierResult,
          ...(supplierPrice != null ? { supplierPrice: BigInt(supplierPrice) } : {}),
        },
      });
      return { done: true, state: "PROCESSING" };
    });

    if (!acted.done) {
      return res.json({ ok: true, skip: acted.reason || "no-op", state: acted.state || null });
    }
    return res.json({ ok: true, state: acted.state, supplier: supplier.code });
  } catch (e) {
    console.error("supplierCallbackUniversal:", e);
    return res.json({ ok: false, error: "internal-error" });
  }
}
