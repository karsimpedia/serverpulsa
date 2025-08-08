// api/controllers/transactionDetail.js
import prisma from "../prisma.js";

const toNum = (v) => (v == null ? null : Number(v));

export async function getTransactionByInvoice(req, res) {
  try {
    const resellerId = req.reseller.id;
    const { invoiceId } = req.params;
    if (!invoiceId) return res.status(400).json({ error: "invoiceId wajib." });

    // Ambil transaksi + produk
    const trx = await prisma.transaction.findUnique({
      where: { invoiceId },
      include: {
        product: { select: { id: true, code: true, name: true, margin: true } },
      },
    });

    if (!trx || trx.resellerId !== resellerId) {
      return res.status(404).json({ error: "Transaksi tidak ditemukan." });
    }

    // Cari costPrice dari supplierProduct (kalau ada supplierId)
    let costPrice = 0n;
    if (trx.supplierId) {
      const sp = await prisma.supplierProduct.findFirst({
        where: { supplierId: trx.supplierId, productId: trx.productId },
        select: { costPrice: true },
      });
      costPrice = BigInt(sp?.costPrice ?? 0n);
    }

    const sellPrice = BigInt(trx.sellPrice ?? 0n);
    const adminFee  = BigInt(trx.adminFee ?? 0n);
    let margin = sellPrice - costPrice - adminFee;
    if (margin < 0n) margin = 0n;

    // Ambil komisi yang sudah dibayar untuk trx ini
    // Prefer TransactionCommission jika ada model itu.
    // Kalau tidak ada, fallback dari MutasiSaldo (CREDIT) dengan trxId dan note komisi.
    let commissions = [];
    let commissionTotal = 0n;

    // Fallback MutasiSaldo (umum di setup kamu)
    const mutasi = await prisma.mutasiSaldo.findMany({
      where: {
        trxId: trx.id,
        type: "CREDIT",
        // optional: filter note mengandung "Komisi", kalau mau lebih ketat:
        // note: { contains: "Komisi" }
      },
      select: {
        resellerId: true,
        amount: true,
        note: true,
        createdAt: true,
        reseller: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    commissions = mutasi.map((m) => ({
      resellerId: m.resellerId,
      resellerName: m.reseller?.name || null,
      note: m.note,
      amount: toNum(m.amount),
      createdAt: m.createdAt,
    }));
    commissionTotal = mutasi.reduce((acc, m) => acc + BigInt(m.amount), 0n);

    // Response
    return res.json({
      invoiceId: trx.invoiceId,
      status: trx.status,
      msisdn: trx.msisdn,
      product: {
        id: trx.product.id,
        code: trx.product.code,
        name: trx.product.name,
      },
      monetary: {
        sellPrice: toNum(sellPrice),
        adminFee: toNum(adminFee),
        costPrice: toNum(costPrice),
        margin: toNum(margin),
        commissionTotal: toNum(commissionTotal),
        marginRemaining: toNum(margin - commissionTotal < 0n ? 0n : margin - commissionTotal),
      },
      supplier: {
        supplierId: trx.supplierId,
        supplierRef: trx.supplierRef,
      },
      timestamps: {
        createdAt: trx.createdAt,
        updatedAt: trx.updatedAt,
        expiresAt: trx.expiresAt,
        callbackSentAt: trx.callbackSentAt,
      },
      commissions, // daftar payout komisi per upline (kalau ada)
      raw: {
        supplierPayload: trx.supplierPayload,
        supplierResult: trx.supplierResult,
      },
    });
  } catch (err) {
    console.error("getTransactionByInvoice error:", err);
    return res.status(500).json({ error: "Gagal mengambil detail transaksi." });
  }
}
