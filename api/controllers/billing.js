// api/controllers/billing.js
import axios from "axios";
import prisma from "../prisma.js";
import { trxQueue } from "../../queues.js";
import bcrypt from "bcrypt";
// ==== Util BigInt-safe ====
const toNum = (v) => (v == null ? null : Number(v));

// ==== Supplier picker (mirip worker) ====
async function pickSupplierWithEndpoint(productId) {
  const list = await prisma.supplierProduct.findMany({
    where: {
      productId,
      isAvailable: true,
      supplier: { status: "ACTIVE" },
    },
    include: { supplier: { include: { endpoints: true } } },
    orderBy: [{ priority: "asc" }, { costPrice: "asc" }],
  });
  for (const sp of list) {
    const ep = sp.supplier.endpoints.find((e) => e.isActive);
    if (ep) return { sp, ep };
  }
  return null;
}

// ==== Call supplier: INQUIRY ====
async function supplierInquiry(ep, sp, { invoiceId, customerNo }) {
  const url = `${ep.baseUrl.replace(/\/+$/, "")}/inquiry`;
  const headers = {};
  if (ep.apiKey) headers["x-api-key"] = ep.apiKey;

  const body = {
    ref: invoiceId,
    sku: sp.supplierSku,
    customerNo,
  };

  try {
    const { data } = await axios.post(url, body, { headers, timeout: 10000 });
    // Normalisasi hasil inquiry (silakan sesuaikan dengan supplier nyata)
    // Harapkan: { status:'OK', amount, adminFee, customerName, period, supplierRef }
    return {
      ok: true,
      raw: data,
      amount: BigInt(data.amount ?? 0),
      adminFee: BigInt(data.adminFee ?? 0),
      customerName: data.customerName ?? null,
      period: data.period ?? null,
      supplierRef: data.supplierRef ?? data.ref ?? null,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ==== Controller: INQUIRY tagihan ====
// body: { productCode, customerNo }
export async function inquiryBill(req, res) {
  try {
    const { productCode, customerNo } = req.body;
    const resellerId = req.reseller.id;

    if (!productCode || !customerNo) {
      return res.status(400).json({ error: "productCode & customerNo wajib." });
    }

    const product = await prisma.product.findUnique({ where: { code: productCode } });
    if (!product || product.type !== "TAGIHAN" || !product.isActive) {
      return res.status(400).json({ error: "Produk tagihan tidak tersedia." });
    }

    // pilih supplier + endpoint
    const picked = await pickSupplierWithEndpoint(product.id);
    if (!picked) return res.status(503).json({ error: "Supplier tidak tersedia untuk produk ini." });
    const { sp, ep } = picked;

    const invoiceId = `TRX-${Date.now()}`;

    // hit inquiry ke supplier
    const iq = await supplierInquiry(ep, sp, { invoiceId, customerNo });
    if (!iq.ok || !iq.supplierRef) {
      return res.status(502).json({ error: "Gagal inquiry ke supplier.", detail: iq.error || iq.raw });
    }

    // simpan TRANSACTION PENDING (tanpa hold saldo)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const trx = await prisma.transaction.create({
      data: {
        invoiceId,
        resellerId,
        productId: product.id,
        msisdn: customerNo,              // simpan no pelanggan di msisdn
        sellPrice: 0n,                   // akan diisi saat pay
        adminFee: iq.adminFee || 0n,
        status: "PENDING",
        supplierId: sp.supplierId,
        supplierRef: iq.supplierRef,
        supplierPayload: { step: "INQUIRY", request: { productCode, customerNo } },
        supplierResult: iq.raw,
        expiresAt,
      },
    });

    const total = iq.amount + (iq.adminFee || 0n) + BigInt(product.margin || 0n);

    return res.json({
      invoiceId,
      customerNo,
      customerName: iq.customerName,
      period: iq.period,
      amount: toNum(iq.amount),
      adminFee: toNum(iq.adminFee),
      productMargin: toNum(product.margin),
      totalPay: toNum(total),
      expiresAt,
    });
  } catch (err) {
    console.error("inquiryBill error:", err);
    return res.status(500).json({ error: "Gagal melakukan inquiry tagihan." });
  }
}

// ==== Controller: BAYAR tagihan ====
// body: { invoiceId }
export async function payBill(req, res) {
  try {
    const { invoiceId , pin} = req.body;
    const resellerId = req.reseller.id;


  if (!pin) {
    return res.status(400).json({ error: "PIN wajib." });
  }
  if (!/^\d{6}$/.test(String(pin))) {
    return res.status(400).json({ error: "PIN harus 6 digit angka." });
  }

 // 0) Verifikasi PIN reseller
    const reseller = await prisma.reseller.findUnique({
      where: { id: resellerId },
      select: { id: true, pin: true, isActive: true },
    });
    if (!reseller || !reseller.isActive) {
      return res.status(403).json({ error: "Reseller tidak aktif." });
    }
    if (!reseller.pin) {
      return res.status(403).json({ error: "PIN belum diset. Hubungi admin." });
    }
    const okPin = await bcrypt.compare(String(pin), reseller.pin);
    if (!okPin) {
      return res.status(403).json({ error: "PIN salah." });
    }

    if (!invoiceId) return res.status(400).json({ error: "invoiceId wajib." });

    const trx = await prisma.transaction.findUnique({
      where: { invoiceId },
      include: { product: true },
    });
    if (!trx || trx.resellerId !== resellerId) {
      return res.status(404).json({ error: "Transaksi tidak ditemukan." });
    }
    if (trx.status !== "PENDING") {
      return res.status(400).json({ error: `Transaksi tidak dalam status PENDING (saat ini: ${trx.status}).` });
    }
    if (trx.expiresAt && trx.expiresAt.getTime() < Date.now()) {
      // tandai expired
      await prisma.transaction.update({ where: { id: trx.id }, data: { status: "EXPIRED" } });
      return res.status(400).json({ error: "Transaksi sudah kedaluwarsa." });
    }

    // Ambil nilai tagihan dari hasil inquiry yang disimpan
    const amount = BigInt(trx.supplierResult?.amount ?? 0n);
    const adminFeeInquiry = BigInt(trx.supplierResult?.adminFee ?? trx.adminFee ?? 0n);
    const margin = BigInt(trx.product?.margin ?? 0n);

    const sellPrice = amount + margin;      // harga dasar + margin produk
    const adminFee = adminFeeInquiry;       // fee dari inquiry

    // Cek saldo & hold
    const saldo = await prisma.saldo.findUnique({ where: { resellerId } });
    if (!saldo) return res.status(400).json({ error: "Saldo reseller tidak ditemukan." });

    const need = sellPrice + adminFee;
    if (saldo.amount < need) {
      return res.status(400).json({ error: "Saldo tidak cukup untuk membayar tagihan." });
    }

    // Hold saldo dan update trx (dalam satu transaksi DB)
    const updated = await prisma.$transaction(async (tx) => {
      // update harga final (sellPrice/adminFee) + status tetap PENDING
      const t = await tx.transaction.update({
        where: { id: trx.id },
        data: {
          sellPrice,
          adminFee,
          // biarkan status PENDING; worker akan set PROCESSING/SUCCESS/FAILED
        },
      });

      await tx.saldo.update({
        where: { resellerId },
        data: { amount: saldo.amount - need },
      });

      await tx.mutasiSaldo.create({
        data: {
          resellerId,
          trxId: trx.id,
          amount: -need,
          type: "DEBIT",
          note: `Hold saldo untuk ${trx.invoiceId} (pembayaran tagihan)`,
        },
      });

      return t;
    });

    // enqueue job khusus bayar tagihan
    await trxQueue.add(
      "dispatch_paybill",
      { trxId: updated.id },
      { removeOnComplete: true, removeOnFail: true }
    );

    return res.json({
      invoiceId,
      status: "PENDING",
      amount: toNum(amount),
      adminFee: toNum(adminFee),
      margin: toNum(margin),
      totalHeld: toNum(need),
      message: "Pembayaran diproses. Cek status berkala.",
    });
  } catch (err) {
    console.error("payBill error:", err);
    return res.status(500).json({ error: "Gagal memproses pembayaran tagihan." });
  }
}


export async function inquiryOnly(req, res) {
  try {
    const { productCode, customerNo } = req.body;
    const resellerId = req.reseller.id;

    if (!productCode || !customerNo) {
      return res.status(400).json({ error: "productCode & customerNo wajib." });
    }

    const product = await prisma.product.findUnique({ where: { code: productCode } });
    if (!product || product.type !== "TAGIHAN" || !product.isActive) {
      return res.status(400).json({ error: "Produk tagihan tidak tersedia." });
    }

    const picked = await pickSupplierWithEndpoint(product.id);
    if (!picked) return res.status(503).json({ error: "Supplier tidak tersedia." });
    const { sp, ep } = picked;

    const invoiceId = `TRX-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const headers = ep.apiKey ? { "x-api-key": ep.apiKey } : {};
    const url = `${ep.baseUrl.replace(/\/+$/, "")}/inquiry`;
    const body = { ref: invoiceId, sku: sp.supplierSku, customerNo };

    // balapan 5 detik
    const payReq = axios.post(url, body, { headers, timeout: 15000 });
    const timeout5s = new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 5000));

    const raced = await Promise.race([payReq, timeout5s]);

    if (raced === "TIMEOUT") {
      // simpan transaksi PROCESSING (tanpa hold saldo) agar bisa dipantau/poll
      const trx = await prisma.transaction.create({
        data: {
          invoiceId,
          resellerId,
          productId: product.id,
          msisdn: customerNo,          // pakai msisdn sbg customerNo
          sellPrice: 0n,
          adminFee: 0n,
          status: "PROCESSING",
          supplierId: sp.supplierId,
          supplierRef: null,
          supplierPayload: { step: "INQUIRY", request: body },
          supplierResult: { note: "Under processing (timeout 5s)" },
          expiresAt,
        },
      });

      // (opsional) enqueue polling kalau worker kamu siap
      try {
        await trxQueue.add("poll_inquiry", { trxId: trx.id }, { delay: 10_000, removeOnComplete: true, removeOnFail: true });
      } catch (_) {}

      return res.json({
        invoiceId,
        status: "PROCESSING",
        message: "Inquiry sedang diproses, silakan cek status berkala.",
        expiresAt,
      });
    }

    // Supplier balas cepat
    const { data } = raced;
    // Normalisasi: pastikan field berikut ada sesuai API supplier kamu
    const responseOk = true; // bisa validasi flag dari supplier
    const amount = BigInt(data.amount ?? 0);
    const adminFee = BigInt(data.adminFee ?? 0);
    const supplierRef = data.supplierRef ?? data.ref ?? null;

    // simpan catatan inquiry (tetap PROCESSING, tanpa hold saldo)
    await prisma.transaction.create({
      data: {
        invoiceId,
        resellerId,
        productId: product.id,
        msisdn: customerNo,
        sellPrice: 0n,
        adminFee,
        status: "PROCESSING", // tetap processing—ini cuma inquiry
        supplierId: sp.supplierId,
        supplierRef,
        supplierPayload: { step: "INQUIRY", request: body },
        supplierResult: data,
        expiresAt,
      },
    });

    return res.json({
      invoiceId,
      status: responseOk ? "OK" : "UNKNOWN",
      customerNo,
      customerName: data.customerName ?? null,
      period: data.period ?? null,
      amount: toNum(amount),
      adminFee: toNum(adminFee),
      productMargin: Number(product.margin ?? 0n),
      supplierRef,
      expiresAt,
    });
  } catch (err) {
    console.error("inquiryOnly error:", err);
    return res.status(500).json({ error: "Gagal melakukan inquiry." });
  }
}