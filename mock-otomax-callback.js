// mock-otomax-callback.js
import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/** ===========================
 *  Fake DB (in-memory)
 *  =========================== */
const members = new Map(); // key: memberID
// contoh default member
members.set("M001", {
  memberID: "M001",
  pin: "1234",
  password: "secret",
  saldo: 1_000_000,
  callbackUrl: "", // opsional, bisa di-set lewat /admin/member
});

const trxDb = new Map(); // key: refID
const products = new Map([
  // product -> buy_price
  ["PULSA5", 6000],
  ["PULSA10", 11000],
  ["PULSA20", 21000],
  ["PULSA50", 51000],
  ["PULSA100", 101000],
]);

/** ===========================
 *  Util
 *  =========================== */
function makeSignature({ memberID, product, dest, refID, pin, password }) {
  const raw = `OtomaX|${memberID}|${product}|${dest}|${refID}|${pin}|${password}`;
  return crypto.createHash("sha1").update(raw).digest("base64url");
}

function validateSignature(qs, member) {
  const { memberID, product, dest, refID, sign } = qs;
  const expected = makeSignature({
    memberID,
    product,
    dest,
    refID,
    pin: member.pin,
    password: member.password,
  });
  return expected === sign;
}

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** ===========================
 *  Callback sender (POST JSON) + retry
 *  =========================== */
async function sendCallback(url, payload, tryNo = 1) {
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const ok = res.ok;
    if (!ok) throw new Error(`Callback HTTP ${res.status}`);
    console.log(`🔔 Callback OK → ${url} (try ${tryNo})`);
  } catch (err) {
    console.error(`🔁 Callback gagal (try ${tryNo}):`, err.message);
    if (tryNo < 5) {
      const backoff = Math.min(2000 * 2 ** (tryNo - 1), 15000); // 2s,4s,8s,16s,15s
      await sleep(backoff);
      return sendCallback(url, payload, tryNo + 1);
    } else {
      console.error("❌ Callback give up setelah 5x percobaan.");
    }
  }
}

/** ===========================
 *  Simulasi proses transaksi
 *  =========================== */
async function simulateProcessing(refID) {
  const trx = trxDb.get(refID);
  if (!trx) return;

  // Delay acak 2–6 detik
  await sleep(2000 + Math.floor(Math.random() * 4000));

  // Tentukan hasil (70% sukses)
  const success = Math.random() < 0.7;
  trx.status = success ? "SUKSES" : "GAGAL";
  trx.message = success ? "Topup berhasil" : "Topup gagal";
  trx.updatedAt = nowIso();
  trxDb.set(refID, trx);

  // Callback
  const payload = {
    // sesuai mapping umum OtomaX-style
    ref: trx.refID,
    status: trx.status, // "SUKSES" | "GAGAL" | "PROSES"
    message: trx.message,
    buy_price: trx.buy_price,
    product: trx.product,
    msisdn: trx.dest,
    supplier_time: trx.updatedAt,
  };
const targetUrl = "http://localhost:3000/api/callback/OTOMAX-1"
//   const targetUrl = trx.callbackOverride || trx.member.callbackUrl;
  await sendCallback(targetUrl, payload);
}

/** ===========================
 *  ROUTES
 *  =========================== */

/**
 * GET /transaksi
 * memberID, product, dest, refID, sign, [callback] (optional override)
 */
app.get("/trx", async (req, res) => {

  console.log(req.query)
  try {
    const { memberID, product, dest, refID, sign, callback } = req.query;

    if (!memberID || !product || !dest || !refID || !sign) {
      return res.json({ status: "GAGAL", message: "Parameter kurang" });
    }

    const member = members.get(String(memberID));
    if (!member) return res.json({ status: "GAGAL", message: "Member tidak dikenal" });

    if (!validateSignature(req.query, member)) {
      return res.json({ status: "GAGAL", message: "Signature tidak valid" });
    }

    if (trxDb.has(refID)) {
      // idempotent duplicate → kembalikan status terakhir
      const last = trxDb.get(refID);
      return res.json({
        refID,
        status: last.status,
        message: last.message,
        buy_price: last.buy_price,
      });
    }

    const buy_price = products.get(String(product)) ?? 10000;

    const trx = {
      refID: String(refID),
      memberID: String(memberID),
      product: String(product),
      dest: String(dest),
      status: "PROSES",
      message: "Transaksi diproses",
      buy_price,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      member,
      callbackOverride: callback ? String(callback) : "", // prioritas di atas default member
    };

    trxDb.set(refID, trx);

    // Mulai simulasi proses + callback async
    simulateProcessing(refID);

    return res.json({
      refID,
      status: "PROSES",
      message: "Transaksi sedang diproses",
      buy_price,
    });
  } catch (e) {
    console.error(e);
    return res.json({ status: "GAGAL", message: "Error tidak terduga" });
  }
});

/**
 * GET /cektrx
 * memberID, refID, sign? (opsional)
 * Mengembalikan status terakhir transaksi.
 */
app.get("/cektrx", (req, res) => {
  const { memberID, refID } = req.query;
  if (!memberID || !refID) {
    return res.json({ status: "GAGAL", message: "Parameter kurang" });
  }
  const trx = trxDb.get(String(refID));
  if (!trx) return res.json({ status: "GAGAL", message: "RefID tidak ditemukan" });

  return res.json({
    refID: trx.refID,
    status: trx.status,
    message: trx.message,
    buy_price: trx.buy_price,
    product: trx.product,
    dest: trx.dest,
    updatedAt: trx.updatedAt,
  });
});

/**
 * GET /ceksaldo
 * memberID, sign? (opsional)
 */
app.get("/ceksaldo", (req, res) => {
  const { memberID } = req.query;
  if (!memberID) return res.json({ status: "GAGAL", message: "memberID kosong" });

  const member = members.get(String(memberID));
  if (!member) return res.json({ status: "GAGAL", message: "Member tidak dikenal" });

  return res.json({
    status: "SUKSES",
    saldo: member.saldo,
    message: "Saldo tersedia",
  });
});

/**
 * POST /admin/member
 * Body JSON: { memberID, pin, password, saldo, callbackUrl }
 * Buat/ubah member & default callback.
 */
app.post("/admin/member", (req, res) => {
  const { memberID, pin, password, saldo, callbackUrl } = req.body || {};
  if (!memberID || !pin || !password) {
    return res.status(400).json({ error: "memberID, pin, password wajib" });
  }
  const m = members.get(memberID) || {};
  const obj = {
    memberID: String(memberID),
    pin: String(pin),
    password: String(password),
    saldo: Number.isFinite(Number(saldo)) ? Number(saldo) : m.saldo ?? 1_000_000,
    callbackUrl: callbackUrl ? String(callbackUrl) : m.callbackUrl ?? "",
  };
  members.set(memberID, obj);
  return res.json({ ok: true, member: obj });
});

/**
 * GET /admin/trx
 * Debug: list transaksi
 */
app.get("/admin/trx", (req, res) => {
  const list = [...trxDb.values()].map((t) => ({
    refID: t.refID,
    memberID: t.memberID,
    product: t.product,
    dest: t.dest,
    status: t.status,
    message: t.message,
    buy_price: t.buy_price,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
  res.json({ count: list.length, data: list });
});

app.listen(PORT, () => {
  console.log(`🚀 Mock OtomaX supplier running at http://localhost:${PORT}`);
});
