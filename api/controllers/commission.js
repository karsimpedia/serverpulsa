// api/controllers/commission.js
import prisma from "../prisma.js";

// ===== Helpers =====
function parsePositiveBigInt(input) {
  if (input == null) return 0n;
  const bi = BigInt(
    typeof input === "string" ? input.trim() : String(Math.floor(Number(input || 0)))
  );
  if (bi < 0n) return 0n;
  return bi;
}
function toStr(n) {
  try { return n != null ? n.toString() : "0"; } catch { return "0"; }
}
function ensureResellerContext(req) {
  if (!req.user || !req.user.resellerId) {
    const err = new Error("Hanya reseller yang bisa mengakses resource ini");
    err.statusCode = 403;
    throw err;
  }
  return req.user.resellerId;
}

// ===== 1) Overview / balance komisi milik reseller =====
export async function getMyCommissionOverview(req, res) {
  try {
    const resellerId = ensureResellerContext(req);

    const [bal, sums] = await Promise.all([
      prisma.commissionBalance.findUnique({
        where: { resellerId },
        select: { amount: true }
      }),
      prisma.commissionMutation.groupBy({
        by: ["type"],
        where: { resellerId },
        _sum: { amount: true }
      })
    ]);

    const wallet = BigInt(bal?.amount ?? 0n);

    let earned = 0n, reversed = 0n, paidOut = 0n;
    for (const r of (sums || [])) {
      const t = r.type;
      const s = BigInt(r._sum.amount ?? 0n);
      if (t === "EARN") earned += s;           // positif
      else if (t === "REVERSAL") reversed += s; // negatif
      else if (t === "PAYOUT") paidOut += s;    // negatif
    }

    return res.json({
      ok: true,
      resellerId,
      wallet: toStr(wallet),
      totals: {
        earned: toStr(earned),
        reversed: toStr(reversed),  // biasanya negatif
        paidOut: toStr(paidOut)     // biasanya negatif
      }
    });
  } catch (e) {
    console.error("getMyCommissionOverview error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Gagal mengambil overview komisi" });
  }
}

// ===== 2) List mutasi dompet komisi (ledger wallet) =====
export async function listMyCommissionMutations(req, res) {
  try {
    const resellerId = ensureResellerContext(req);

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
    const skip = (page - 1) * limit;

    const type = req.query.type ? String(req.query.type).toUpperCase() : null; // EARN|REVERSAL|PAYOUT
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to ? new Date(req.query.to) : null;

    const where = { resellerId };
    if (type) where.type = type;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to)   where.createdAt.lte = to;
    }

    const [rows, total, wallet] = await Promise.all([
      prisma.commissionMutation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip, take: limit,
        select: {
          id: true, transactionId: true, type: true, amount: true,
          beforeAmount: true, afterAmount: true, note: true, createdAt: true
        }
      }),
      prisma.commissionMutation.count({ where }),
      prisma.commissionBalance.findUnique({
        where: { resellerId },
        select: { amount: true }
      })
    ]);

    return res.json({
      ok: true,
      page, limit, total,
      wallet: toStr(BigInt(wallet?.amount ?? 0n)),
      data: rows.map(r => ({
        id: r.id,
        transactionId: r.transactionId,
        type: r.type,
        amount: toStr(BigInt(r.amount ?? 0n)),
        beforeAmount: toStr(BigInt(r.beforeAmount ?? 0n)),
        afterAmount: toStr(BigInt(r.afterAmount ?? 0n)),
        note: r.note,
        createdAt: r.createdAt
      }))
    });
  } catch (e) {
    console.error("listMyCommissionMutations error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Gagal mengambil mutasi komisi" });
  }
}

// ===== 3) List komisi per-transaksi (ledger TransactionCommission) =====
export async function listMyTransactionCommissions(req, res) {
  try {
    const resellerId = ensureResellerContext(req);

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
    const skip = (page - 1) * limit;

    const status = req.query.status ? String(req.query.status).toUpperCase() : null; // filter status trx opsional
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to ? new Date(req.query.to) : null;

    const where = { resellerId };
    // Kita join via include & filter transaksi saat perlu
    const [rows, total] = await Promise.all([
      prisma.transactionCommission.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip, take: limit,
        include: {
          transaction: {
            select: {
              id: true, invoiceId: true, status: true,
              productId: true, createdAt: true, resellerId: true
            }
          }
        }
      }),
      prisma.transactionCommission.count({ where })
    ]);

    // apply filter tanggal/status di memory (kalau mau, bisa diquery builder lebih kompleks)
    const filtered = rows.filter(r => {
      const t = r.transaction;
      if (!t) return false;
      if (status && t.status !== status) return false;
      if (from && t.createdAt < from) return false;
      if (to && t.createdAt > to) return false;
      return true;
    });

    return res.json({
      ok: true,
      page, limit,
      total: status || from || to ? filtered.length : total,
      data: (status || from || to ? filtered : rows).map(r => ({
        id: r.id,
        transactionId: r.transaction?.id,
        invoiceId: r.transaction?.invoiceId,
        transactionStatus: r.transaction?.status,
        level: r.level,
        amount: toStr(BigInt(r.amount ?? 0n)), // bisa + (earn) atau - (reversal)
        createdAt: r.createdAt
      }))
    });
  } catch (e) {
    console.error("listMyTransactionCommissions error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Gagal mengambil daftar komisi transaksi" });
  }
}

// ===== 4) Payout komisi → Saldo utama (oleh reseller) =====
const MIN_PAYOUT = BigInt(process.env.COMMISSION_MIN_PAYOUT || "1000"); // ubah sesuai kebijakan
const COMMISSION_PAYOUT_FEE = BigInt(process.env.COMMISSION_PAYOUT_FEE || "0");

export async function postMyCommissionPayout(req, res) {
  try {
    const resellerId = ensureResellerContext(req);

    // amount: nominal yang diminta reseller. Bisa "ALL" untuk ambil semua.
    const rawAmount = req.body?.amount;
    if (rawAmount == null) return res.status(400).json({ error: "amount wajib diisi" });

    // Ambil saldo dompet komisi terkini
    const bal = await prisma.commissionBalance.findUnique({
      where: { resellerId },
      select: { amount: true }
    });
    const wallet = BigInt(bal?.amount ?? 0n);
    if (wallet <= 0n) return res.status(400).json({ error: "Saldo komisi kosong" });

    let gross;
    if (typeof rawAmount === "string" && rawAmount.trim().toUpperCase() === "ALL") {
      gross = wallet;
    } else {
      gross = parsePositiveBigInt(rawAmount);
    }

    if (gross < MIN_PAYOUT) {
      return res.status(400).json({ error: `Minimal payout adalah ${MIN_PAYOUT.toString()}` });
    }
    if (gross > wallet) {
      return res.status(400).json({ error: "Saldo komisi tidak cukup" });
    }

    const fee = COMMISSION_PAYOUT_FEE;
    const net = gross - fee;
    if (net <= 0n) return res.status(400).json({ error: "Jumlah terlalu kecil setelah fee" });

    let beforeWallet, afterWallet, beforeSaldo, afterSaldo, payoutId;

    await prisma.$transaction(async (tx) => {
      // 1) Debit dompet komisi
      const curBal = await tx.commissionBalance.findUnique({
        where: { resellerId },
        select: { amount: true }
      });
      const cur = BigInt(curBal?.amount ?? 0n);
      if (cur < gross) throw new Error("Saldo komisi tidak cukup (race)");

      beforeWallet = cur;
      afterWallet = cur - gross;

      await tx.commissionBalance.upsert({
        where: { resellerId },
        create: { resellerId, amount: afterWallet },
        update: { amount: afterWallet }
      });

      await tx.commissionMutation.create({
        data: {
          resellerId,
          type: "PAYOUT",
          amount: -gross, // negatif
          beforeAmount: beforeWallet,
          afterAmount: afterWallet,
          note: `Payout komisi ke saldo utama (fee ${fee.toString()})`
        }
      });

      // 2) Credit saldo utama
      const srow = await tx.saldo.findUnique({
        where: { resellerId },
        select: { amount: true }
      });
      const sBefore = BigInt(srow?.amount ?? 0n);
      const sAfter = sBefore + net;

      beforeSaldo = sBefore;
      afterSaldo = sAfter;

      await tx.saldo.upsert({
        where: { resellerId },
        create: { resellerId, amount: sAfter },
        update: { amount: sAfter }
      });

      await tx.mutasiSaldo.create({
        data: {
          resellerId,
          trxId: "COMMISSION_PAYOUT",
          type: "CREDIT",
          source: "COMMISSION_PAYOUT",
          amount: net,
          beforeAmount: sBefore,
          afterAmount: sAfter,
          note: `Payout komisi (gross ${gross.toString()}, fee ${fee.toString()})`,
          status: "SUCCESS"
        }
      });

      // 3) Log CommissionPayout
      const cp = await tx.commissionPayout.create({
        data: {
          resellerId,
          amount: gross,
          fee,
          status: "PAID",
          note: "Auto payout oleh reseller",
          processedAt: new Date()
        }
      });
      payoutId = cp.id;
    });

    return res.json({
      ok: true,
      payoutId,
      wallet: { before: toStr(beforeWallet), after: toStr(afterWallet) },
      saldo:  { before: toStr(beforeSaldo),  after: toStr(afterSaldo)  },
      fee: toStr(COMMISSION_PAYOUT_FEE),
      gross: toStr(gross),
      net: toStr(net)
    });
  } catch (e) {
    console.error("postMyCommissionPayout error:", e);
    return res.status(e.statusCode || 500).json({ error: e.message || "Gagal payout komisi" });
  }
}
