// api/controllers/topup.js
import prisma from "../prisma.js";
import bcrypt from "bcrypt";
import { trxQueue } from "../../queues.js";
import { pickSupplierForProduct } from "../lib/supplierPicker.js";
import { computeEffectiveSellPrice } from "../lib/effective-price.js";
import { genInvoiceId } from "../lib/invoice-id.js";
import { validateCategoryPrefix } from "../lib/categoryPrefix.js";
import { emitTrxNew } from "../lib/realtime.js";
const onlyDigits = (s = "") => String(s).replace(/[^\d]/g, "");
const getClientIp = (req) =>
  (Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"] || ""
  )
    .toString()
    .split(",")[0]
    .trim() ||
  req.ip ||
  null;

export async function createTopup(req, res) {
  try {
    let {
      resellerId,
      productCode,
      msisdn, // wajib
      externalRefId, // = idtrx
      pin,
      deviceType, // wajib
      identifier, // wajib (deviceId)
    } = req.body;

    // ===== validasi input dasar =====
    if (
      !resellerId ||
      !productCode ||
      !msisdn ||
      !pin ||
      !deviceType ||
      !identifier
    ) {
      return res.status(400).json({
        error:
          "Data tidak lengkap. resellerId, productCode, msisdn, pin, deviceType, dan identifier wajib diisi.",
      });
    }
    if (!/^\d{6}$/.test(String(pin))) {
      return res.status(400).json({ error: "PIN harus 6 digit angka." });
    }

    productCode = String(productCode).trim().toUpperCase();
    const destMsisdn = onlyDigits(msisdn);
    if (!destMsisdn)
      return res.status(422).json({ error: "Nomor tujuan tidak valid." });
    const typeDevice = String(deviceType ?? "")
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
    if (!allowedDevice)
      return res
        .status(403)
        .json({ error: "Device tidak diizinkan untuk melakukan transaksi." });
    if (allowedDevice.resellerId !== resellerId)
      return res
        .status(403)
        .json({ error: "Tidak diizinkan memakai device ini." });

    // ===== reseller aktif + verifikasi PIN =====
    const reseller = await prisma.reseller.findUnique({
      where: { id: resellerId },
      select: { id: true, isActive: true, pin: true },
    });
    if (!reseller || !reseller.isActive)
      return res.status(403).json({ error: "Reseller tidak aktif" });

    const pinOK = await bcrypt.compare(String(pin), reseller.pin || "");
    if (!pinOK) return res.status(403).json({ error: "PIN salah" });

    // ===== produk by code =====
    const product = await prisma.product.findUnique({
      where: { code: productCode },
    });
    if (!product || !product.isActive) {
      return res
        .status(404)
        .json({ error: "Produk tidak ditemukan atau tidak aktif." });
    }

    const ok = await validateCategoryPrefix(msisdn, product.categoryId);
    if (!ok) {
      // Dapatkan nama kategori (opsional untuk pesan)
      const cat = product.categoryId
        ? await prisma.productCategory.findUnique({
            where: { id: product.categoryId },
            select: { name: true },
          })
        : null;

      return res.status(400).json({
        error: `Nomor ${msisdn} tidak sesuai prefix untuk kategori ${
          cat?.name ?? "(tanpa kategori)"
        }.`,
      });
    }

    // ===== Guard #1: idtrx (externalRefId) tidak boleh dipakai ulang oleh reseller yang sama =====
    if (externalRefId) {
      const dup = await prisma.transaction.findUnique({
        where: { resellerId_externalRefId: { resellerId, externalRefId } },
        select: { id: true, status: true },
      });
      if (dup) {
        return res.status(409).json({
          error: "ID transaksi (idtrx/externalRefId) sudah digunakan.",
          trxId: dup.id,
          status: dup.status,
        });
      }
    }

    // ===== Guard #2: jika idtrx TIDAK ADA, atau SAMA dengan transaksi aktif, larang duplikat nomor+reseller =====
    // Cek transaksi aktif (pending/processing) untuk reseller + msisdn + product ini
    const activeSame = await prisma.transaction.findFirst({
      where: {
        resellerId,
        productId: product.id,
        msisdn: destMsisdn,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      select: { id: true, externalRefId: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    // Blokir jika:
    // - externalRefId tidak diisi, ATAU
    // - externalRefId sama dengan transaksi aktif yang ditemukan (harusnya tidak mungkin karena Guard #1, tapi jaga-jaga)
    if (
      activeSame &&
      (!externalRefId || externalRefId === activeSame.externalRefId)
    ) {
      return res.status(409).json({
        error:
          "Ada transaksi aktif untuk nomor & produk yang sama oleh reseller ini. Tunggu selesai atau kirim dengan idtrx (externalRefId) yang unik.",
        existingTrxId: activeSame.id,
        existingStatus: activeSame.status,
      });
    }

    // ===== pilih supplier =====
    const supplierPick = await pickSupplierForProduct(product.id);
    if (!supplierPick) {
      return res
        .status(503)
        .json({ error: "Tidak ada supplier aktif untuk produk ini" });
    }
    const { supplier, endpoint, supplierProduct } = supplierPick;

    // ===== harga & hold =====
    const { effectiveSell } = await computeEffectiveSellPrice(
      reseller.id,
      product.id
    );
    const sellPrice = effectiveSell; // BigInt
    const adminFee = 0n;
    const holdAmount = sellPrice + adminFee;

    const invoiceId = genInvoiceId();
    let created;
    const clientInfo = {
      identifier: String(identifier).slice(0, 128),
      deviceId: String(identifier).slice(0, 128),
      deviceType: String(typeDevice).slice(0, 32),
      ip: getClientIp(req),
      userAgent: req.get("user-agent") || null,
    };

    // ===== transaksi: HOLD saldo + create trx =====
    await prisma.$transaction(async (tx) => {
      const current =
        (await tx.saldo.findUnique({ where: { resellerId: reseller.id } }))
          ?.amount ?? 0n;
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
          status: "WAITING",
          supplierId: supplier.id,
          supplierRef: null,
          supplierPayload: {
            endpointId: endpoint.id,
            baseUrl: endpoint.baseUrl,
            supplierSku: supplierProduct.supplierSku,
            costPrice: supplierProduct.costPrice,
            client: clientInfo, // audit device/ip/UA
          },
          externalRefId: externalRefId || null,
          message: "WAITING (queued)",
        },
      });

      await tx.mutasiSaldo.updateMany({
        where: {
          trxId: invoiceId,
          resellerId: reseller.id,
          source: "TRX_HOLD",
        },
        data: { trxId: created.id },
      });

      await tx.device.updateMany({
        where: {
          resellerId,
          type: String(typeDevice),
          identifier: String(identifier),
        },
        data: { lastSeenAt: new Date(), lastIp: clientInfo.ip },
      });
    });

    // ===== enqueue ke worker =====
    await trxQueue.add(
      "trx",
      { op: "topup", trxId: created.id },
      { attempts: 2, backoff: { type: "exponential", delay: 3000 } }
    );

    // Realtime
    emitTrxNew(req.app.locals.trxNsp, {
      id: created.id,
      invoiceId: created.invoiceId,
      resellerId: created.resellerId,
      productCode: product.code,
      msisdn: created.msisdn,
      amount: Number(created.sellPrice),
      status: created.status,
      supplierName: supplier.name,
      message: created.message,
      createdAt: created.createdAt,
    });

    return res.json({
      success: true,
      trxId: created.id,
      invoiceId,
      productCode,
      msisdn,
      status: "Transaksi berhasil dikirim",
    });
  } catch (e) {
    return res
      .status(400)
      .json({ error: e?.message || "Gagal membuat transaksi" });
  }
}
