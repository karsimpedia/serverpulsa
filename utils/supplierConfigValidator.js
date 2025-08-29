// utils/supplierConfigValidator.js

// 1) Alias → kunci kanonik
const OP_ALIASES = {
  check: "cektrx",
  status: "cektrx",
  cek: "cektrx",
  balance: "ceksaldo",
  saldo: "ceksaldo",
};

// 2) Daftar operasi yang didukung
const ALLOWED_OPS = new Set([
  "topup",     // prepaid topup (e.g. /transaksi)
  "inquiry",   // postpaid inquiry
  "paybill",   // postpaid payment
  "cektrx",    // check transaction status (e.g. /cektrx)
  "ceksaldo",  // check balance (e.g. /ceksaldo)
  "callback",  // webhook mapping (bukan HTTP call)
]);

// helper: string non-empty
function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

// helper: object plain
function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

// Normalisasi alias op keys (tanpa mutasi input)
export function normalizeOpsAliases(ops = {}) {
  const out = {};
  for (const [k, v] of Object.entries(ops || {})) {
    const key = (OP_ALIASES[k] ?? k);
    out[key] = v;
  }
  return out;
}

/**
 * Validasi config.ops
 * - Mengizinkan: topup, inquiry, paybill, cektrx, ceksaldo, callback
 * - Untuk selain 'callback': wajib 'method' & 'path'; 'response' object disarankan
 * - Untuk 'callback': validasi field mapping (refField, statusField, messageField, dst.)
 * Return: ops yang sudah dinormalisasi (alias di-resolve)
 */
export function validateOps(ops) {
  if (!isObj(ops)) throw new Error("ops wajib berupa object");

  const normalized = normalizeOpsAliases(ops);

  for (const k of Object.keys(normalized)) {
    if (!ALLOWED_OPS.has(k)) {
      throw new Error(`ops.${k} tidak dikenali. Gunakan salah satu: ${[...ALLOWED_OPS].join(", ")}`);
    }

    const v = normalized[k];
    if (!isObj(v)) throw new Error(`ops.${k} harus object`);

    // CABANG KHUSUS CALLBACK (webhook mapping, bukan HTTP request)
    if (k === "callback") {
      const {
        refField,
        statusField,
        messageField,
        priceField,        // opsional
        idMode,            // "invoiceId" | "id" (opsional)
        statusAlias,       // { SUKSES:"SUCCESS", GAGAL:"FAILED", PROSES:"PENDING", ... }
        signatureHeader,   // ex: "x-signature" (opsional)
        sigAlgo,           // ex: "sha256" (opsional)
        serialFields,      // ["serial","sn","data.sn","token"] (opsional)
        serialRegex,       // string regex untuk ekstrak SN (opsional)
        serialSourceField, // field sumber SN (opsional)
      } = v;

      if (!isNonEmptyString(refField))    throw new Error("ops.callback.refField wajib diisi (string)");
      if (!isNonEmptyString(statusField)) throw new Error("ops.callback.statusField wajib diisi (string)");
      if (!isNonEmptyString(messageField))throw new Error("ops.callback.messageField wajib diisi (string)");

      if (priceField != null && !isNonEmptyString(priceField)) {
        throw new Error("ops.callback.priceField (jika ada) harus string");
      }
      if (idMode != null && !["invoiceId","id"].includes(idMode)) {
        throw new Error("ops.callback.idMode (jika ada) harus 'invoiceId' atau 'id'");
      }
      if (signatureHeader != null && !isNonEmptyString(signatureHeader)) {
        throw new Error("ops.callback.signatureHeader (jika ada) harus string");
      }
      if (sigAlgo != null && !isNonEmptyString(sigAlgo)) {
        throw new Error("ops.callback.sigAlgo (jika ada) harus string");
      }
      if (serialFields != null && !Array.isArray(serialFields)) {
        throw new Error("ops.callback.serialFields (jika ada) harus array string");
      }
      if (serialRegex != null && !isNonEmptyString(serialRegex)) {
        throw new Error("ops.callback.serialRegex (jika ada) harus string (regex)");
      }
      if (serialSourceField != null && !isNonEmptyString(serialSourceField)) {
        throw new Error("ops.callback.serialSourceField (jika ada) harus string");
      }
      if (statusAlias != null && !isObj(statusAlias)) {
        throw new Error("ops.callback.statusAlias (jika ada) harus object");
      }
      continue; // selesai validasi callback
    }

    // GENERIK untuk op HTTP (topup/inquiry/paybill/cektrx/ceksaldo)
    const { method, path, headers, query, body, response } = v;

    if (!isNonEmptyString(method)) throw new Error(`ops.${k}.method wajib diisi (GET/POST/PUT/PATCH/DELETE)`);
    if (!isNonEmptyString(path))   throw new Error(`ops.${k}.path wajib diisi (string)`);

    // method allowed
    const m = method.toUpperCase();
    const allowedMethods = new Set(["GET","POST","PUT","PATCH","DELETE"]);
    if (!allowedMethods.has(m)) {
      throw new Error(`ops.${k}.method tidak valid: ${method}`);
    }

    if (headers != null && !isObj(headers)) throw new Error(`ops.${k}.headers harus object jika diisi`);
    if (query   != null && !isObj(query))   throw new Error(`ops.${k}.query harus object jika diisi`);
    if (body    != null && !isObj(body))    throw new Error(`ops.${k}.body harus object jika diisi`);

    // response mapping disarankan ada (untuk parsing)
    if (response == null || !isObj(response)) {
      throw new Error(`ops.${k}.response wajib object (mapping cara membaca respons)`);
    }
  }

  return normalized;
}
