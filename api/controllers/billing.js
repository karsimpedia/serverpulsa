// api/controllers/billing.js
import axios from "axios";
import prisma from "../prisma.js";
import { trxQueue } from "../../queues.js";
import bcrypt from "bcrypt";
import { computeEffectiveSellPrice } from "../lib/effective-price.js"; // base + sum(markup)

const toNum = (v) => (v == null ? null : Number(v));

// ==== Supplier picker ====
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
    const { data } = await axios.post(url, body, { headers, timeout: 15000 });
    // Normalisasi hasil inquiry (silakan sesuaikan dg supplier nyata)
    // Ekspektasi: { status:'OK', amount, customerName, period, supplierRef, supplierFee }
    return {
      ok: true,
      raw: data,
      amount: BigInt(data.amount ?? 0),
      supplierFee: BigInt(data.supplierFee ?? 0), // biaya supplier jika ada (biaya ke vendor)
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

    const picked = await pickSupplierWithEndpoint(product.id);
    if (!picked) return res.status(503).json({ error: "Supplier tidak tersedia untuk produk ini." });
    const { sp, ep } = picked;

    const invoiceId = `TRX-${Date.now()}`;

    // hit inquiry ke supplier
    const iq = await supplierInquiry(ep, sp, { invoiceId, customerNo });
    if (!iq.ok || !iq.supplierRef) {
      return res.status(502).json({ error: "Gagal inquiry ke supplier.", detail: iq.error || iq.raw });
    }

    // --- Hitung harga customer berdasarkan markup chain ---
    // baseAdminFee = product.margin (kebijakan admin)
    const baseAdminFee = BigInt(product.margin ?? 0n);

    // total markup berantai = effectiveSell(reseller) - (basePrice+margin)
    const baseDefault = BigInt(product.basePrice || 0n) + BigInt(product.margin || 0n);
    const { effectiveSell } = await computeEffectiveSellPrice(resellerId, product.id);
    let markupSum = BigInt(effectiveSell) - baseDefault;
    if (markupSum < 0n) markupSum = 0n;

    // Harga final yang dibayar customer:
    // sellPrice = amountDue + baseAdminFee + markupSum
    const sellPrice = BigInt(iq.amount) + baseAdminFee + markupSum;

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // simpan TRANSACTION: TAGIHAN_INQUIRY (tidak hold saldo)
    const trx = await prisma.transaction.create({
      data: {
        invoiceId,
        resellerId,
        productId: product.id,
        msisdn: customerNo,     // simpan ID pelanggan di field msisdn
        type: "TAGIHAN_INQUIRY",
        sellPrice,              // harga final yg akan ditagih saat PAY
        adminFee: baseAdminFee, // admin fee dasar kita (bukan biaya supplier)
        markupSum,              // total markup berantai
        amountDue: iq.amount,   // dari supplier
        status: "QUOTED",
        supplierId: sp.supplierId,
        supplierRef: iq.supplierRef,
        supplierPayload: {
          step: "INQUIRY",
          endpointId: ep.id,
          baseUrl: ep.baseUrl,
          supplierSku: sp.supplierSku,
          supplierFee: iq.supplierFee,  // biaya vendor (bila ada) → untuk analitik/kontenjan
          request: { productCode, customerNo },
        },
        supplierResult: iq.raw,
        expiresAt,
        message: iq.raw?.message || "OK",
      },
    });

    return res.json({
      ok: true,
      invoiceId,
      customerNo,
      customerName: iq.customerName,
      period: iq.period,
      amountDue: toNum(iq.amount),
      adminFee: toNum(baseAdminFee),
      markupSum: toNum(markupSum),
      sellPrice: toNum(sellPrice),
      expiresAt,
      note: "Gunakan invoiceId ini untuk PAY dalam 5 menit.",
    });
  } catch (err) {
    console.error("inquiryBill error:", err);
    return res.status(500).json({ error: "Gagal melakukan inquiry tagihan." });
  }
}

// ==== Controller: BAYAR tagihan ====
// body: { invoiceId, pin }
export async function payBill(req, res) {
  try {
    const { invoiceId, pin } = req.body;
    const resellerId = req.reseller.id;

    if (!pin) return res.status(400).json({ error: "PIN wajib." });
    if (!/^\d{6}$/.test(String(pin))) {
      return res.status(400).json({ error: "PIN harus 6 digit angka." });
    }

    // Verifikasi PIN reseller
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
    if (trx.type !== "TAGIHAN_INQUIRY") {
      return res.status(400).json({ error: "invoiceId bukan transaksi inquiry tagihan." });
    }
    if (trx.status !== "QUOTED") {
      return res.status(400).json({ error: `Transaksi tidak siap dibayar (status: ${trx.status}).` });
    }
    if (trx.expiresAt && trx.expiresAt.getTime() < Date.now()) {
      await prisma.transaction.update({ where: { id: trx.id }, data: { status: "EXPIRED" } });
      return res.status(400).json({ error: "Transaksi sudah kedaluwarsa." });
    }

    // Nilai final sudah disimpan saat inquiry
    const sellPrice = BigInt(trx.sellPrice || 0n);
    const adminFee = BigInt(trx.adminFee || 0n);
    const totalNeed = sellPrice; // adminFee sudah termasuk dalam sellPrice (sellPrice = amountDue + baseAdminFee + markupSum)

    // Cek & HOLD saldo
    const saldo = await prisma.saldo.findUnique({ where: { resellerId } });
    if (!saldo) return res.status(400).json({ error: "Saldo reseller tidak ditemukan." });
    if (saldo.amount < totalNeed) {
      return res.status(400).json({ error: "Saldo tidak cukup untuk membayar tagihan." });
    }

    // Update trx → TAGIHAN_PAY (PENDING), HOLD saldo, relink mutasi
    const updated = await prisma.$transaction(async (tx) => {
      // 1) Ubah tipe & status untuk dibayar
      const t = await tx.transaction.update({
        where: { id: trx.id },
        data: {
          type: "TAGIHAN_PAY",
          status: "PENDING",
          // sellPrice/adminFee/markupSum/amountDue sudah ada dari inquiry
          message: "PENDING (billing pay queued)"
        },
      });

      // 2) HOLD saldo (DEBIT amount positif)
      const before = saldo.amount;
      const after = before - totalNeed;

      await tx.saldo.update({
        where: { resellerId },
        data: { amount: after },
      });

      await tx.mutasiSaldo.create({
        data: {
          resellerId,
          trxId: trx.id,            // pakai id transaksi (bukan invoice) supaya gampang di-refund
          type: "DEBIT",
          source: "TRX_HOLD",
          amount: totalNeed,        // POSITIF
          beforeAmount: before,
          afterAmount: after,
          note: `Hold saldo untuk ${trx.invoiceId} (pembayaran tagihan)`,
          status: "SUCCESS",
        },
      });

      return t;
    });

    // enqueue job bayar tagihan
 await trxQueue.add('trx', { op: 'paybill', trxId: updated.id }, { attempts: 2, backoff: { type: 'exponential', delay: 3000 } });

    return res.json({
      ok: true,
      invoiceId,
      type: "TAGIHAN_PAY",
      status: "PENDING",
      amountDue: toNum(trx.amountDue),
      adminFee: toNum(adminFee),
      markupSum: toNum(trx.markupSum),
      sellPrice: toNum(sellPrice),
      message: "Pembayaran diproses. Cek status berkala.",
    });
  } catch (err) {
    console.error("payBill error:", err);
    return res.status(500).json({ error: "Gagal memproses pembayaran tagihan." });
  }
}

// ==== (Opsional) Inquiry only (fallback cepat) ====
// Mirip inquiryBill, tapi jika supplier lambat, tandai PROCESSING & bisa dipolling.
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

    // === Jalur TIMEOUT: simpan PROCESSING & enqueue worker inquiry ===
    if (raced === "TIMEOUT") {
      const trxCreated = await prisma.transaction.create({
        data: {
          invoiceId,
          resellerId,
          productId: product.id,
          msisdn: customerNo,
          type: "TAGIHAN_INQUIRY",
          sellPrice: 0n,
          adminFee: 0n,
          markupSum: 0n,
          amountDue: 0n,
          status: "PROCESSING",
          supplierId: sp.supplierId,
          supplierRef: null,
          supplierPayload: {
            step: "INQUIRY",
            request: body,
            endpointId: ep.id,
            baseUrl: ep.baseUrl,
            supplierSku: sp.supplierSku
          },
          supplierResult: { note: "Under processing (timeout 5s)" },
          expiresAt,
        },
      });

      // enqueue worker untuk lanjutkan inquiry (failover-ready)
      await trxQueue.add(
        'trx',
        { op: 'inquirybill', trxId: trxCreated.id },
        { attempts: 2, backoff: { type: 'exponential', delay: 3000 } }
      );

      return res.json({
        ok: true,
        invoiceId,
        status: "PROCESSING",
        message: "Inquiry sedang diproses, silakan cek status berkala.",
        expiresAt,
      });
    }

    // === Jalur SUPPLIER BALAS CEPAT ===
    const { data } = raced;
    const amount = BigInt(data.amount ?? 0);
    const supplierFee = BigInt(data.supplierFee ?? 0);
    const supplierRef = data.supplierRef ?? data.ref ?? null;

    // hitung baseAdminFee & markupSum untuk hint harga
    const baseAdminFee = BigInt(product.margin ?? 0n);
    const baseDefault = BigInt(product.basePrice || 0n) + BigInt(product.margin || 0n);
    const { effectiveSell } = await computeEffectiveSellPrice(resellerId, product.id);
    let markupSum = BigInt(effectiveSell) - baseDefault;
    if (markupSum < 0n) markupSum = 0n;
    const sellPrice = amount + baseAdminFee + markupSum;

    const trxCreated = await prisma.transaction.create({
      data: {
        invoiceId,
        resellerId,
        productId: product.id,
        msisdn: customerNo,
        type: "TAGIHAN_INQUIRY",
        sellPrice,
        adminFee: baseAdminFee,
        markupSum,
        amountDue: amount,
        status: "QUOTED", // karena respons cepat, langsung QUOTED
        supplierId: sp.supplierId,
        supplierRef,
        supplierPayload: {
          step: "INQUIRY",
          request: body,
          endpointId: ep.id,
          baseUrl: ep.baseUrl,
          supplierSku: sp.supplierSku,
          supplierFee
        },
        supplierResult: data,
        expiresAt,
      },
    });

    // (opsional) kalau mau tetap konsisten lewat worker untuk normalisasi vendor lain,
    // kamu bisa enqueue juga, tapi biasanya tidak perlu kalau sudah QUOTED.
    // await trxQueue.add('trx', { op: 'inquirybill', trxId: trxCreated.id }, { attempts: 2, backoff: { type: 'exponential', delay: 3000 } });

    return res.json({
      ok: true,
      invoiceId,
      status: "OK",
      customerNo,
      customerName: data.customerName ?? null,
      period: data.period ?? null,
      amountDue: toNum(amount),
      adminFee: toNum(baseAdminFee),
      markupSum: toNum(markupSum),
      sellPrice: toNum(sellPrice),
      supplierRef,
      expiresAt,
    });
  } catch (err) {
    console.error("inquiryOnly error:", err);
    return res.status(500).json({ error: "Gagal melakukan inquiry." });
  }
}
