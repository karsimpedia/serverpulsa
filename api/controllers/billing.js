// api/controllers/billing.js
import prisma from "../prisma.js";
import bcrypt from "bcrypt";
import { trxQueue } from "../../queues.js";
import { computeEffectiveSellPrice } from "../lib/effective-price.js";
import { callSupplier } from "../lib/supplier-client.js";
import { pickSupplierWithEndpoint } from "../../utils/supplierPicker.js";
import { emitTrxNew, emitTrxUpdate} from "../lib/realtime.js";

const toNum = (v) => (v == null ? null : Number(v));
// Sanitize nominal (hilangkan titik/koma/spasi)
const sanitizeAmount = (a) => {
  if (a == null) return undefined;
  const s = String(a).replace(/[^\d]/g, "");
  return s.length ? s : undefined;
};

// ==== Call supplier: INQUIRY ====
async function supplierInquiry(ep, sp, { invoiceId, customerNo, msisdn, amount }) {
  try {
    const supplierCode = sp.supplier.code;
    const amountSan = sanitizeAmount(amount);

    const res = await callSupplier("inquiry", supplierCode, {
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey || undefined,
      secret: ep.secret || undefined,
      ref: invoiceId,
      product: sp.supplierSku,
      customerNo, // Nomor ID
      msisdn,     // Nomor Tujuan
      ...(amountSan ? { amount: amountSan } : {}),
    });

    if (!res?.ok) {
      return { ok: false, error: res?.error || "transport error", raw: res?.data };
    }

    const norm = res.norm || {};
    return {
      ok: true,
      raw: res.data,
      amount: norm.amount ?? null,             // BigInt|null
      supplierFee: norm.adminFee ?? null,      // BigInt|null
      customerName: norm.extra?.customerName ?? null,
      period: norm.extra?.period ?? null,
      supplierRef: norm.supplierRef ?? null,
      message: norm.message ?? null,
      status: norm.status ?? "PENDING",
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ==== INQUIRY tagihan ====
// body: { productCode, idNumber, dest, amount? }
export async function inquiryBill(req, res) {
  try {
    const { productCode, idNumber, dest, amount } = req.body;
    const resellerId = req.reseller.id;

    if (!productCode) return res.status(400).json({ error: "productCode wajib." });
    if (!idNumber || !dest) {
      return res.status(400).json({ error: "idNumber (Nomor ID) dan dest (Nomor Tujuan) wajib." });
    }

    const amountSan = sanitizeAmount(amount);
    if (amount != null && !amountSan) {
      return res.status(400).json({ error: "amount tidak valid (harus angka tanpa pemisah)." });
    }

    const product = await prisma.product.findUnique({ where: { code: productCode } });
    if (!product || product.type !== "TAGIHAN" || !product.isActive) {
      return res.status(400).json({ error: "Produk tagihan tidak tersedia." });
    }

    const picked = await pickSupplierWithEndpoint(product.id);
    if (!picked) return res.status(503).json({ error: "Supplier tidak tersedia untuk produk ini." });
    const { sp, ep } = picked;

    const invoiceId = `TRX-${Date.now()}`;

    // inquiry ke supplier (untuk dapatkan nominal/tagihan/alias/period/supplierRef)
    const iq = await supplierInquiry(ep, sp, {
      invoiceId,
      customerNo: String(idNumber),
      msisdn: String(dest),
      amount: amountSan,
    });

    if (!iq.ok || !iq.supplierRef) {
      return res.status(502).json({ error: "Gagal inquiry ke supplier.", detail: iq.error || iq.raw });
    }

    // harga customer
    const baseAdminFee = BigInt(product.margin ?? 0n);
    const baseDefault = BigInt(product.basePrice || 0n) + BigInt(product.margin || 0n);
    const { effectiveSell } = await computeEffectiveSellPrice(resellerId, product.id);
    let markupSum = BigInt(effectiveSell) - baseDefault;
    if (markupSum < 0n) markupSum = 0n;

    const amountDue = BigInt(iq.amount ?? 0n);
    const sellPrice = amountDue + baseAdminFee + markupSum;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const trx = await prisma.transaction.create({
      data: {
        invoiceId,
        resellerId,
        productId: product.id,
        msisdn: String(dest),
        type: "TAGIHAN_INQUIRY",
        sellPrice,
        adminFee: baseAdminFee,
        ...(typeof markupSum === "bigint" ? { markupSum } : {}),
        ...(typeof amountDue === "bigint" ? { amountDue } : {}),
        status: "WAITING", // ← belum diproses/dikirim ke supplier untuk pembayaran
        supplierId: sp.supplierId,
        supplierRef: iq.supplierRef,
        supplierPayload: {
          step: "INQUIRY",
          endpointId: ep.id,
          baseUrl: ep.baseUrl,
          supplierSku: sp.supplierSku,
          supplierFee: iq.supplierFee ?? null,
          request: {
            productCode,
            idNumber: String(idNumber),
            dest: String(dest),
            ...(amountSan ? { amount: amountSan } : {}),
          },
        },
        supplierResult: iq.raw,
        expiresAt,
        message: iq.message || "OK",
      },
    });

    // Realtime
    emitTrxNew(req.app.locals.trxNsp, {
      id: trx.id,
      invoiceId: trx.invoiceId,
      resellerId: trx.resellerId,
      productCode: product.code,
      msisdn: trx.msisdn,
      amount: Number(trx.sellPrice),
      status: trx.status, // WAITING
      supplierName: (sp?.supplier?.name) || null,
      message: trx.message,
      createdAt: trx.createdAt,
    });

    return res.json({
      ok: true,
      invoiceId,
      idNumber: String(idNumber),
      dest: String(dest),
      ...(amountSan ? { amount: Number(amountSan) } : {}),
      customerName: iq.customerName,
      period: iq.period,
      amountDue: toNum(amountDue),
      adminFee: toNum(baseAdminFee),
      markupSum: toNum(markupSum),
      sellPrice: toNum(sellPrice),
      supplierRef: iq.supplierRef,
      expiresAt,
      status: "WAITING",
      note: "Gunakan invoiceId ini untuk PAY dalam 5 menit.",
    });
  } catch (err) {
    console.error("inquiryBill error:", err);
    return res.status(500).json({ error: "Gagal melakukan inquiry tagihan." });
  }
}

// ==== BAYAR tagihan ====
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
    // Hanya boleh dari WAITING (hasil inquiry)
    if (trx.type !== "TAGIHAN_INQUIRY" || trx.status !== "WAITING") {
      return res.status(400).json({ error: `Transaksi tidak siap dibayar (type: ${trx.type}, status: ${trx.status}).` });
    }
    if (trx.expiresAt && trx.expiresAt.getTime() < Date.now()) {
      await prisma.transaction.update({ where: { id: trx.id }, data: { status: "EXPIRED" } });
      return res.status(400).json({ error: "Transaksi sudah kedaluwarsa." });
    }

    // Nilai final dari inquiry
    const sellPrice = BigInt(trx.sellPrice || 0n);
    const adminFee = BigInt(trx.adminFee || 0n);
    const totalNeed = sellPrice;

    // HOLD saldo
    const saldo = await prisma.saldo.findUnique({ where: { resellerId } });
    if (!saldo) return res.status(400).json({ error: "Saldo reseller tidak ditemukan." });
    if (saldo.amount < totalNeed) {
      return res.status(400).json({ error: "Saldo tidak cukup untuk membayar tagihan." });
    }

    // Update → TAGIHAN_PAY + WAITING (belum dikirim ke supplier), HOLD saldo, relink mutasi
    const updated = await prisma.$transaction(async (tx) => {
      const t = await tx.transaction.update({
        where: { id: trx.id },
        data: {
          type: "TAGIHAN_PAY",
          status: "WAITING", // masih antri untuk dikirim ke supplier oleh worker
          message: "WAITING (billing pay queued)",
          supplierPayload: { ...(trx.supplierPayload || {}), step: "PAY" },
        },
      });

      const before = saldo.amount;
      const after = before - totalNeed;

      await tx.saldo.update({ where: { resellerId }, data: { amount: after } });

      await tx.mutasiSaldo.create({
        data: {
          resellerId,
          trxId: trx.id,
          type: "DEBIT",
          source: "TRX_HOLD",
          amount: totalNeed,
          beforeAmount: before,
          afterAmount: after,
          note: `Hold saldo untuk ${trx.invoiceId} (pembayaran tagihan)`,
          status: "SUCCESS",
        },
      });

      return t;
    });

    // enqueue job bayar tagihan (worker yang akan callSupplier('paybill', ...) & update status selanjutnya)
    await trxQueue.add('trx', { op: 'paybill', trxId: updated.id }, { attempts: 2, backoff: { type: 'exponential', delay: 3000 } });

    return res.json({
      ok: true,
      invoiceId,
      type: "TAGIHAN_PAY",
      status: "WAITING",
      amountDue: toNum(trx.amountDue),
      adminFee: toNum(adminFee),
      markupSum: toNum(trx.markupSum),
      sellPrice: toNum(sellPrice),
      message: "Pembayaran diantrikan. Menunggu eksekusi ke supplier.",
    });
  } catch (err) {
    console.error("payBill error:", err);
    return res.status(500).json({ error: "Gagal memproses pembayaran tagihan." });
  }
}

// ==== Inquiry only (fallback cepat) ====
// body: { productCode, idNumber, dest, amount? }
export async function inquiryOnly(req, res) {
  try {
    const { productCode, idNumber, dest, amount } = req.body;
    const resellerId = req.reseller.id;

    if (!productCode) return res.status(400).json({ error: "productCode wajib." });
    if (!idNumber || !dest) {
      return res.status(400).json({ error: "idNumber (Nomor ID) dan dest (Nomor Tujuan) wajib." });
    }

    const amountSan = sanitizeAmount(amount);
    if (amount != null && !amountSan) {
      return res.status(400).json({ error: "amount tidak valid (harus angka tanpa pemisah)." });
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

    // balapan 5 detik
    const reqPromise = callSupplier("inquiry", sp.supplier.code, {
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey || undefined,
      secret: ep.secret || undefined,
      ref: invoiceId,
      product: sp.supplierSku,
      customerNo: String(idNumber),
      msisdn: String(dest),
      ...(amountSan ? { amount: amountSan } : {}),
    });
    const timeout5s = new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 5000));

    const raced = await Promise.race([reqPromise, timeout5s]);

    // === TIMEOUT: simpan PROCESSING & enqueue worker inquiry ===
    if (raced === "TIMEOUT") {
      const trxCreated = await prisma.transaction.create({
        data: {
          invoiceId,
          resellerId,
          productId: product.id,
          msisdn: String(dest),
          type: "TAGIHAN_INQUIRY",
          sellPrice: 0n,
          adminFee: 0n,
          ...(typeof 0n === "bigint" ? { markupSum: 0n, amountDue: 0n } : {}),
          status: "PROCESSING",
          supplierId: sp.supplierId,
          supplierRef: null,
          supplierPayload: {
            step: "INQUIRY",
            request: {
              ref: invoiceId,
              product: sp.supplierSku,
              idNumber: String(idNumber),
              dest: String(dest),
              ...(amountSan ? { amount: amountSan } : {}),
            },
            endpointId: ep.id,
            baseUrl: ep.baseUrl,
            supplierSku: sp.supplierSku
          },
          supplierResult: { note: "Under processing (timeout 5s)" },
          expiresAt,
        },
      });

      // Realtime
      emitTrxNew(req.app.locals.trxNsp, {
        id: trxCreated.id,
        invoiceId: trxCreated.invoiceId,
        resellerId: trxCreated.resellerId,
        productCode: product.code,
        msisdn: trxCreated.msisdn,
        amount: Number(trxCreated.sellPrice),
        status: trxCreated.status, // PROCESSING
        supplierName: (sp?.supplier?.name) || null,
        message: trxCreated.message,
        createdAt: trxCreated.createdAt,
      });

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

    // === Supplier balas cepat ===
    const resIQ = raced;
    if (!resIQ?.ok) {
      return res.status(502).json({ error: "Gagal inquiry ke supplier.", detail: resIQ?.error || resIQ });
    }

    const norm = resIQ.norm || {};
    const amountDue = BigInt(norm.amount ?? 0n);
    const supplierFee = norm.adminFee ?? 0n;
    const supplierRef = norm.supplierRef ?? null;

    const baseAdminFee = BigInt(product.margin ?? 0n);
    const baseDefault = BigInt(product.basePrice || 0n) + BigInt(product.margin || 0n);
    const { effectiveSell } = await computeEffectiveSellPrice(resellerId, product.id);
    let markupSum = BigInt(effectiveSell) - baseDefault;
    if (markupSum < 0n) markupSum = 0n;
    const sellPrice = amountDue + baseAdminFee + markupSum;

    const trxCreated = await prisma.transaction.create({
      data: {
        invoiceId,
        resellerId,
        productId: product.id,
        msisdn: String(dest),
        type: "TAGIHAN_INQUIRY",
        sellPrice,
        adminFee: baseAdminFee,
        markupSum,
        amountDue,
        status: "WAITING", // sudah ada data, menunggu bayar
        supplierId: sp.supplierId,
        supplierRef,
        supplierPayload: {
          step: "INQUIRY",
          request: {
            ref: invoiceId,
            product: sp.supplierSku,
            idNumber: String(idNumber),
            dest: String(dest),
            ...(amountSan ? { amount: amountSan } : {}),
          },
          endpointId: ep.id,
          baseUrl: ep.baseUrl,
          supplierSku: sp.supplierSku,
          supplierFee
        },
        supplierResult: resIQ.data,
        expiresAt,
      },
    });

    // Realtime
    emitTrxNew(req.app.locals.trxNsp, {
      id: trxCreated.id,
      invoiceId: trxCreated.invoiceId,
      resellerId: trxCreated.resellerId,
      productCode: product.code,
      msisdn: trxCreated.msisdn,
      amount: Number(trxCreated.sellPrice),
      status: trxCreated.status, // WAITING
      supplierName: (sp?.supplier?.name) || null,
      message: trxCreated.message,
      createdAt: trxCreated.createdAt,
    });

    return res.json({
      ok: true,
      invoiceId,
      status: "WAITING",
      idNumber: String(idNumber),
      dest: String(dest),
      ...(amountSan ? { amount: Number(amountSan) } : {}),
      customerName: norm.extra?.customerName ?? null,
      period: norm.extra?.period ?? null,
      amountDue: toNum(amountDue),
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
