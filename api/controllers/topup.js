// api/controllers/topup.js
import prisma from "../prisma.js";
import bcrypt from "bcrypt";
import { trxQueue } from "../../queues.js";
import { pickSupplierForProduct } from "../lib/supplier-pick.js";
import { computeEffectiveSellPrice } from "../lib/effective-price.js";
import { genInvoiceId } from "../lib/invoice-id.js";

const onlyDigits = (s = "") => String(s).replace(/[^\d]/g, "");
const getClientIp = (req) =>
  (Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : (req.headers["x-forwarded-for"] || "")).toString().split(",")[0].trim() ||
  req.ip ||
  null;

export async function createTopup(req, res) {
  try {
    const {
      resellerId,
      productCode,
      msisdn,         // wajib
      externalRefId,
      pin,
      deviceType,     // wajib
      identifier,     // wajib (deviceId)
    } = req.body;

    // ===== validasi input dasar =====
    if (!resellerId || !productCode || !msisdn || !pin || !deviceType || !identifier) {
      return res.status(400).json({
        error: "Data tidak lengkap. resellerId, productCode, msisdn, pin, deviceType, dan identifier wajib diisi.",
      });
    }
    if (!/^\d{6}$/.test(String(pin))) {
      return res.status(400).json({ error: "PIN harus 6 digit angka." });
    }

    const destMsisdn = onlyDigits(msisdn);
    if (!destMsisdn) {
      return res.status(422).json({ error: "Nomor tujuan tidak valid." });
    }
const typeDevice = String(deviceType ?? '')
  .trim()
  .toUpperCase();
    // ===== validasi device terdaftar & aktif =====
    const allowedDevice = await prisma.device.findFirst({
      where: {
        resellerId,
        type: String(typeDevice),
        identifier: String(identifier),
        isActive: true,
      },
      select: { id: true, resellerId: true },
    });
    if (!allowedDevice) {
      return res.status(403).json({ error: "Device tidak diizinkan untuk melakukan transaksi." });
    }
    if (allowedDevice.resellerId !== resellerId) {
      return res.status(403).json({ error: "Tidak diizinkan memakai device ini." });
    }

    // ===== reseller aktif + verifikasi PIN =====
    const reseller = await prisma.reseller.findUnique({
      where: { id: resellerId },
      select: { id: true, isActive: true, pin: true },
    });
    if (!reseller || !reseller.isActive) {
      return res.status(403).json({ error: "Reseller tidak aktif" });
    }
    const pinOK = await bcrypt.compare(String(pin), reseller.pin || "");
    if (!pinOK) return res.status(403).json({ error: "PIN salah" });

    // ===== produk by code =====
    const product = await prisma.product.findUnique({ where: { code: productCode } });
    if (!product || !product.isActive) {
      return res.status(404).json({ error: "Produk tidak ditemukan atau tidak aktif." });
    }

    // ===== pilih supplier =====
    const supplierPick = await pickSupplierForProduct(product.id);
    if (!supplierPick) {
      return res.status(503).json({ error: "Tidak ada supplier aktif untuk produk ini" });
    }
    const { supplier, endpoint, supplierProduct } = supplierPick;

    // ===== harga & hold =====
    const { effectiveSell } = await computeEffectiveSellPrice(reseller.id, product.id);
    const sellPrice = effectiveSell; // BigInt
    const adminFee = 0n;
    const holdAmount = sellPrice + adminFee;

    // ===== idempoten via externalRefId =====
    if (externalRefId) {
      const dup = await prisma.transaction.findUnique({
        where: { resellerId_externalRefId: { resellerId, externalRefId } },
      });
      if (dup) {
        // catat lastSeen device walau transaksi di-reuse
        await prisma.device.updateMany({
          where: { resellerId, type: String(deviceType), identifier: String(identifier) },
          data: { lastSeenAt: new Date(), lastIp: getClientIp(req) },
        });
        return res.json({ ok: true, reused: true, trxId: dup.id, status: dup.status });
      }
    }

    const invoiceId = genInvoiceId();
    let created;
    const clientInfo = {
      identifier: String(identifier).slice(0, 128),
      deviceId: String(identifier).slice(0, 128),
      deviceType: String(deviceType).slice(0, 32),
      ip: getClientIp(req),
      userAgent: req.get("user-agent") || null,
    };

    // ===== transaksi: HOLD saldo + create trx =====
    await prisma.$transaction(async (tx) => {
      const current = (await tx.saldo.findUnique({ where: { resellerId: reseller.id } }))?.amount ?? 0n;
      if (current < holdAmount) throw new Error("Saldo tidak cukup");

      const after = current - holdAmount;

      await tx.saldo.upsert({
        where: { resellerId: reseller.id },
        create: { resellerId: reseller.id, amount: after },
        update: { amount: after },
      });

      await tx.mutasiSaldo.create({
        data: {
          trxId: invoiceId, // sementara; setelah create trx akan di-update
          resellerId: reseller.id,
          type: "DEBIT",
          source: "TRX_HOLD",
          amount: holdAmount,
          beforeAmount: current,
          afterAmount: after,
          note: `Hold untuk ${product.code}/${destMsisdn} [${clientInfo.deviceType}:${clientInfo.deviceId}]`,
          status: "SUCCESS",
        },
      });

      created = await tx.transaction.create({
        data: {
          invoiceId,
          resellerId: reseller.id,
          productId: product.id,
          msisdn: destMsisdn,
          sellPrice,
          adminFee,
          status: "PENDING",
          supplierId: supplier.id,
          supplierRef: null,
          supplierPayload: {
            endpointId: endpoint.id,
            baseUrl: endpoint.baseUrl,
            supplierSku: supplierProduct.supplierSku,
            costPrice: supplierProduct.costPrice,
            client: clientInfo, // audit device/ip/UA
          },
          externalRefId,
          message: "PENDING (queued)",
        },
      });

      await tx.mutasiSaldo.updateMany({
        where: { trxId: invoiceId, resellerId: reseller.id, source: "TRX_HOLD" },
        data: { trxId: created.id },
      });

      // update lastSeen device
      await tx.device.updateMany({
        where: { resellerId, type: String(deviceType), identifier: String(identifier) },
        data: { lastSeenAt: new Date(), lastIp: clientInfo.ip },
      });
    });

    // ===== enqueue ke worker =====
    await trxQueue.add(
      "trx",
      { op: "topup", trxId: created.id },
      { attempts: 2, backoff: { type: "exponential", delay: 3000 } }
    );

    return res.json({ ok: true, trxId: created.id, invoiceId, status: "PENDING" });
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Gagal membuat transaksi" });
  }
}
