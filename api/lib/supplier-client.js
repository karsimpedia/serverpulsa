// api/lib/supplier-client.js
import axios from "axios";
import crypto from "crypto";
import { getSupplierConfigByCode } from "./supplier-registry-db.js";

// Mini templating: ganti {{var}} dari context
function render(tpl, ctx) {
  if (tpl == null) return tpl;
  if (typeof tpl === "string") {
    return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const keys = k.split(".");
      let v = ctx;
      for (const kk of keys) v = v?.[kk];
      return v == null ? "" : String(v);
    });
  } else if (Array.isArray(tpl)) {
    return tpl.map((x) => render(x, ctx));
  } else if (typeof tpl === "object") {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = render(v, ctx);
    return out;
  }
  return tpl;
}

function getPath(obj, pathStr) {
  if (!pathStr) return undefined;
  return pathStr.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
}

function normalizeStatus(raw, map) {
  if (raw == null) return "PENDING";
  const key = String(raw).toUpperCase();
  return map?.[key] || map?.[raw] || key;
}

// ===== Signing utilities =====
function digest({ algo, input, key, encoding = "hex", uppercase = false }) {
  let out;
  const a = String(algo || "").toLowerCase();
  if (a.startsWith("hmac-")) {
    const h = crypto.createHmac(a.replace("hmac-", ""), key ?? "");
    h.update(input);
    out = h.digest(encoding);
  } else {
    const h = crypto.createHash(a || "md5");
    h.update(input);
    out = h.digest(encoding);
  }
  return uppercase ? String(out).toUpperCase() : out;
}

/**
 * signSpec format (bisa di conf.sign atau defaults.sign):
 * {
 *   type: "md5" | "sha1" | "sha256" | "hmac-sha1" | "hmac-sha256" | "hmac-sha512",
 *   template: "{{username}}{{apiKey}}{{ref}}",     // string setelah render
 *   keyTemplate: "{{secret}}",                     // untuk HMAC
 *   encoding: "hex" | "base64" | "base64url",
 *   uppercase: true|false,
 *   set: { place: "header"|"body"|"query"|"ctx", name: "signature" }  // taruh ke mana
 * }
 */
function applySignature({ ctx, headers, body, query, spec }) {
  if (!spec) return { ctx, headers, body, query };
  const input = render(spec.template || "", ctx);
  const key = render(spec.keyTemplate || "", ctx);
  const signature = digest({
    algo: spec.type || "md5",
    input,
    key,
    encoding: spec.encoding || "hex",
    uppercase: !!spec.uppercase,
  });

  const place = spec.set?.place || "ctx";
  const name = spec.set?.name || "signature";

  if (place === "header") headers[name] = signature;
  else if (place === "body") body[name] = signature;
  else if (place === "query") query[name] = signature;
  else ctx[name] = signature;

  return { ctx, headers, body, query };
}

/**
 * callSupplier(op, supplierCode, ctx)
 * ctx: { baseUrl, apiKey, secret?, ref, sku, msisdn, customerNo, amount, ... }
 * Konfigurasi di DB (SupplierConfig.ops[op]) boleh punya:
 * - method, path, headers, body, query, bodyType("json"|"form"), timeoutMs
 * - sign (lihat spec di atas)
 * - response: { statusPath, messagePath, supplierRefPath, amountPath, adminFeePath, extraPaths:{...}, statusMap:{..} }
 * - auth (opsional): { type:"basic", username:"{{...}}", password:"{{...}}" }
 */
export async function callSupplier(op, supplierCode, ctx) {
  // 1) Baca konfigurasi supplier & op
  const sc = await getSupplierConfigByCode(supplierCode);
  const conf = sc.ops?.[op];
  if (!conf) throw new Error(`Operation ${op} tidak dikonfigurasi untuk ${supplierCode}`);

  // 2) Siapkan context + waktu + secret fallback
  const now = Date.now();
  const baseCtx = {
    nowMs: now,
    nowSec: Math.floor(now / 1000),
    nowIso: new Date(now).toISOString(),
    secret: ctx.secret ?? sc.defaults?.secret, // kalau default punya secret
    ...ctx,
  };

  // 3) Render dasar
  const baseUrl = (baseCtx.baseUrl || "").replace(/\/+$/, "");
  const url = baseUrl + render(conf.path, baseCtx);
  const method = String(conf.method || "POST").toUpperCase();

  // Headers/body/query dari template
  let headers = { ...(sc.defaults?.headers || {}) };
  headers = { ...headers, ...(render(conf.headers || {}, baseCtx)) };
  let body = render(conf.body || {}, baseCtx) || {};
  let query = render(conf.query || {}, baseCtx) || {};

  // 4) Signature (conf.sign > defaults.sign)
  const signSpec = conf.sign || sc.defaults?.sign;
  ({ ctx: baseCtx, headers, body, query } = applySignature({
    ctx: baseCtx,
    headers,
    body,
    query,
    spec: signSpec,
  }));

  // 5) Opsi bodyType & axios config
  const timeout = Number(conf.timeoutMs ?? sc.defaults?.timeoutMs ?? 25000);
  const bodyType = (conf.bodyType || "json").toLowerCase(); // "json" | "form"

  const axiosCfg = {
    url,
    method,
    headers: { ...headers },
    timeout,
  };

  if (conf.auth?.type === "basic") {
    axiosCfg.auth = {
      username: render(conf.auth.username || "", baseCtx),
      password: render(conf.auth.password || "", baseCtx),
    };
  }

  if (method === "GET") {
    axiosCfg.params = { ...query, ...body };
  } else {
    axiosCfg.params = query;
    if (bodyType === "form") {
      axiosCfg.headers["Content-Type"] = "application/x-www-form-urlencoded";
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) usp.append(k, v == null ? "" : String(v));
      axiosCfg.data = usp.toString();
    } else {
      axiosCfg.headers["Content-Type"] = "application/json";
      axiosCfg.data = body;
    }
  }

  // 6) Request
  let resp;
  try {
    resp = await axios.request(axiosCfg);
  } catch (e) {
    // simpan log singkat supaya trace gampang
    console.error("[supplier-client] transport error:", e?.message || e);
    return { ok: false, transportError: true, error: e?.message || String(e) };
  }

  // 7) Normalisasi response
  const data = resp?.data;
  const map = conf.response?.statusMap || {};
  const statusRaw = getPath(data, conf.response?.statusPath);
  const status = normalizeStatus(statusRaw, map);
  const message = getPath(data, conf.response?.messagePath) ?? status;
  const supplierRef = getPath(data, conf.response?.supplierRefPath) ?? null;

  const amountStr = conf.response?.amountPath ? getPath(data, conf.response.amountPath) : null;
  const adminFeeStr = conf.response?.adminFeePath ? getPath(data, conf.response.adminFeePath) : null;

  const extra = {};
  if (conf.response?.extraPaths) {
    for (const [k, pth] of Object.entries(conf.response.extraPaths)) {
      extra[k] = getPath(data, pth) ?? null;
    }
  }

  return {
    ok: true,
    data,
    norm: {
      status: String(status).toUpperCase(),
      message,
      supplierRef,
      amount: amountStr != null ? BigInt(amountStr) : null,
      adminFee: adminFeeStr != null ? BigInt(adminFeeStr) : null,
      extra,
    },
  };
}
