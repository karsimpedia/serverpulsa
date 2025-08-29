// api/lib/supplier-client.js
import axios from "axios";
import crypto from "crypto";
import { getSupplierConfigByCode } from "./supplier-registry-db.js";

/* =========================
 * Mini templating: {{var}}
 * ========================= */
function render(tpl, ctx) {
  if (tpl == null) return tpl;
  if (typeof tpl === "string") {
    return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const keys = k.split(".");
      let v = ctx;
      for (const kk of keys) v = v?.[kk];
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(tpl)) return tpl.map((x) => render(x, ctx));
  if (typeof tpl === "object") {
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
  const keyUpper = String(raw).toUpperCase();
  return map?.[keyUpper] || map?.[raw] || keyUpper;
}

/* =========================
 * Utilities
 * ========================= */
function digest({ algo, input, key, encoding = "hex", uppercase = false }) {
  // Support "base64url" by converting from base64
  const enc = encoding === "base64url" ? "base64" : encoding || "hex";
  const a = String(algo || "md5").toLowerCase();

  let out;
  if (a.startsWith("hmac-")) {
    const h = crypto.createHmac(a.replace("hmac-", ""), key ?? "");
    h.update(String(input));
    out = h.digest(enc);
  } else {
    const h = crypto.createHash(a);
    h.update(String(input));
    out = h.digest(enc);
  }

  if (encoding === "base64url") {
    out = String(out)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
  if (uppercase) out = String(out).toUpperCase();
  return out;
}

function parseBigIntSafe(v) {
  if (v == null) return null;
  const num = String(v).replace(/[^\d]/g, "");
  if (!num) return null;
  try {
    return BigInt(num);
  } catch {
    return null;
  }
}

/**
 * signSpec format (bisa di conf.sign atau defaults.sign):
 * {
 *   type: "md5" | "sha1" | "sha256" | "hmac-sha1" | "hmac-sha256" | "hmac-sha512",
 *   template: "{{username}}{{apiKey}}{{ref}}",
 *   keyTemplate: "{{secret}}",
 *   encoding: "hex" | "base64" | "base64url",
 *   uppercase: true|false,
 *   set: { place: "header"|"body"|"query"|"ctx", name: "signature" }
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

/* =========================
 * Main: callSupplier
 * =========================
 * ctx:
 * {
 *   baseUrl, apiKey, secret?, ref, product?, sku?, msisdn, customerNo, amount,
 *   // Fallback tanpa config (default -> body/query):
 *   pin?, pinPlace? ("body"|"query"), pinField? ("pin"),
 *   // Member/reseller ID (satu sumber dari form "Member ID"):
 *   uid?, memberId?, idMember?, memberID?, idReseller?, resellerId?,
 *   memberPlace? ("body"|"query"), memberField? ("memberID"),
 *   // Optional:
 *   username?,
 *   ...
 * }
 */
export async function callSupplier(op, supplierCode, ctx) {
  // 1) Ambil konfigurasi supplier & operasi
  const sc = await getSupplierConfigByCode(supplierCode);
  console.log("sc", sc);
  if (!sc) throw new Error(`Supplier ${supplierCode} tidak ditemukan`);
  const conf = sc.ops?.[op];
  if (!conf)
    throw new Error(
      `Operation ${op} tidak dikonfigurasi untuk ${supplierCode}`
    );

  // 2) Context + waktu + fallback dari defaults + alias uid/memberId + pin + product
  const now = Date.now();

  // Resolve Member ID (ctx → defaults.credentials → defaults.*)
  const resolvedMemberId =
    ctx.uid ??
    ctx.memberId ??
    ctx.idMember ??
    ctx.memberID ??
    ctx.idReseller ??
    ctx.resellerId ??
    sc?.defaults?.credentials?.memberId ??
    sc?.defaults?.uid ??
    sc?.defaults?.memberId ??
    null;

  // Resolve PIN (ctx → defaults.credentials → defaults.pin)
  const resolvedPin =
    ctx.pin ?? sc?.defaults?.credentials?.pin ?? sc?.defaults?.pin ?? null;

  // Resolve USERNAME (ctx → defaults.credentials → defaults.username)
  const resolvedUsername =
    ctx.username ??
    sc?.defaults?.credentials?.username ??
    sc?.defaults?.username ??
    null;

  // Resolve PASSWORD (ctx → defaults.credentials.password → defaults.password)
  const resolvedPassword =
    ctx.password ??
    ctx.pass ??
    ctx.pwd ??
    sc?.defaults?.credentials?.password ??
    sc?.defaults?.password ??
    null;

  // Resolve PRODUCT/SKU (ctx → defaults.*)
  const resolvedProduct =
    ctx.product ??
    ctx.sku ??
    ctx.codeproduk ??
    ctx.codeProduk ??
    ctx.kodeProduk ??
    ctx.kodeproduk ??
    ctx.produk ??
    sc?.defaults?.product ??
    sc?.defaults?.sku ??
    sc?.defaults?.produk ??
    null;

  let baseCtx = {
    nowMs: now,
    nowSec: Math.floor(now / 1000),
    nowIso: new Date(now).toISOString(),
    // secret: ctx → defaults.webhook.secret → (legacy) defaults.secret
    secret: ctx.secret ?? sc?.defaults?.webhook?.secret ?? sc?.defaults?.secret,

    ...ctx, // izinkan override field lain

    // Username untuk templating/sign jika diperlukan
    username: resolvedUsername ?? ctx.username,

    // alias konsisten untuk templating (Member ID)
    uid: resolvedMemberId,
    memberId: resolvedMemberId,
    memberID: resolvedMemberId,
    idMember: ctx.idMember ?? resolvedMemberId,

    // alias konsisten untuk templating (Product/SKU)
    product: resolvedProduct,
    sku: resolvedProduct,
    produk: resolvedProduct,
    codeproduk: resolvedProduct,
    codeProduk: resolvedProduct,
    kodeProduk: resolvedProduct,
    kodeproduk: resolvedProduct,
    // alias tujuan & referensi untuk template OtomaX
    dest: ctx.dest ?? ctx.msisdn ?? ctx.customerNo ?? null,
    refID: ctx.refID ?? ctx.ref ?? null,
    ref: ctx.ref ?? ctx.refID ?? null,
    // PIN final
    pin: resolvedPin,
    password: resolvedPassword,
  };

  // 3) Render endpoint dasar
  const baseUrl = String(baseCtx.baseUrl || "").replace(/\/+$/, "");
  const url = baseUrl + render(conf.path, baseCtx);
  const method = String(conf.method || "POST").toUpperCase();

  // 4) Render headers/body/query dari template
  let headers = { ...(sc.defaults?.headers || {}) };
  headers = { ...headers, ...render(conf.headers || {}, baseCtx) };
  let body = render(conf.body || {}, baseCtx) || {};
  let query = render(conf.query || {}, baseCtx) || {};

  // 5) Fallback MEMBER (jika tidak ada conf.member) -> default ke body.memberID
  const hasMemberSpec = Object.prototype.hasOwnProperty.call(conf, "member");
  if (!hasMemberSpec && baseCtx.memberId != null) {
    const mPlace = String(baseCtx.memberPlace || "body").toLowerCase();
    const mField = baseCtx.memberField || "memberID";
    if (mPlace === "query") {
      if (query[mField] == null) query[mField] = String(baseCtx.memberId);
    } else {
      if (body[mField] == null) body[mField] = String(baseCtx.memberId);
    }
  }

  // 6) Fallback PIN (jika tidak ada conf.pin) -> default ke body.pin
  const hasPinSpec = Object.prototype.hasOwnProperty.call(conf, "pin");
  if (!hasPinSpec && baseCtx.pin != null) {
    const place = String(baseCtx.pinPlace || "body").toLowerCase();
    const field = baseCtx.pinField || "pin";
    if (place === "query") {
      if (query[field] == null) query[field] = String(baseCtx.pin);
    } else {
      if (body[field] == null) body[field] = String(baseCtx.pin);
    }
  }

  // 7) Signature (conf.sign > defaults.sign)
  console.log(conf.sign);
  const signSpec = conf.sign || sc.defaults?.sign;

  ({
    ctx: baseCtx,
    headers,
    body,
    query,
  } = applySignature({
    ctx: baseCtx,
    headers,
    body,
    query,
    spec: signSpec,
  }));

  // 8) Susun Axios config
  const timeout = Number(conf.timeoutMs ?? sc.defaults?.timeoutMs ?? 25000);
  const bodyType = String(conf.bodyType || "json").toLowerCase(); // "json" | "form"

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
    axiosCfg.params = { ...query, ...body }; // GET: kirim semua via query
  } else {
    axiosCfg.params = query;
    if (bodyType === "form") {
      axiosCfg.headers["Content-Type"] = "application/x-www-form-urlencoded";
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(body))
        usp.append(k, v == null ? "" : String(v));
      axiosCfg.data = usp.toString();
    } else {
      axiosCfg.headers["Content-Type"] = "application/json";
      axiosCfg.data = body;
    }
  }

  // 9) Request
  let resp;
  try {
    resp = await axios.request(axiosCfg);
    console.log(resp)
  } catch (e) {
    // HTTP error (4xx/5xx) masih punya response -> tetap diparse
    if (e?.response) {
      resp = e.response;
    } else {
      // murni transport/timeout/dns
      console.error("[supplier-client] transport error:", e?.message || e);
      return {
        ok: false,
        transportError: true,
        error: e?.message || String(e),
      };
    }
  }

  // 10) Normalisasi response
  const data = resp?.data;
  const map = conf.response?.statusMap || {};
  const statusRaw = getPath(data, conf.response?.statusPath);
  const status = normalizeStatus(statusRaw, map);
  const message = getPath(data, conf.response?.messagePath) ?? status;
  const supplierRef = getPath(data, conf.response?.supplierRefPath) ?? null;

  const amountStr = conf.response?.amountPath
    ? getPath(data, conf.response.amountPath)
    : null;
  const adminFeeStr = conf.response?.adminFeePath
    ? getPath(data, conf.response.adminFeePath)
    : null;

  const extra = {};
  if (conf.response?.extraPaths) {
    for (const [k, pth] of Object.entries(conf.response.extraPaths)) {
      extra[k] = getPath(data, pth) ?? null;
    }
  }

  return {
    ok: true,
    httpStatus: resp?.status ?? null,
    data,
    norm: {
      status: String(status || "PENDING").toUpperCase(),
      message,
      supplierRef,
      amount: parseBigIntSafe(amountStr),
      adminFee: parseBigIntSafe(adminFeeStr),
      extra,
    },
  };
}
