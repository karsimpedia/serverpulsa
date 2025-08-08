// api/controllers/transaction.js
import prisma from "../prisma.js";

/** BigInt → Number agar aman di JSON */
function toPlainTxn(t) {
  if (!t) return t;
  return {
    ...t,
    sellPrice: Number(t.sellPrice),
    adminFee: Number(t.adminFee),
  };
}
function toPlainTxns(list) { return list.map(toPlainTxn); }

/** Helper: normalisasi filter status (bisa "proses", "sukses", "gagal") */
function normalizeStatuses(q) {
  if (!q) return null;
  const map = {
    pending: "PENDING",
    proses: "PROCESSING", processing: "PROCESSING",
    sukses: "SUCCESS", success: "SUCCESS",
    gagal: "FAILED", failed: "FAILED",
    refunded: "REFUNDED", canceled: "CANCELED", expired: "EXPIRED",
  };
  const arr = String(q).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const norm = arr.map(s => map[s] || s.toUpperCase());
  return norm;
}

/**
 * GET /api/transactions
 * Query:
 *  - status=PENDING,PROCESSING,SUCCESS,FAILED (boleh multivalue, boleh pakai "proses,sukses,gagal")
 *  - take (default 20), skip (default 0)
 *  - q (opsional: cari invoiceId/MSISDN)
 */
export async function listTransactions(req, res) {
  try {
    const resellerId = req.reseller.id;
    const take = Math.min(Number(req.query.take || 20), 100);
    const skip = Number(req.query.skip || 0);
    const statuses = normalizeStatuses(req.query.status);
    const q = (req.query.q || "").trim();

    const where = {
      resellerId,
      ...(statuses && statuses.length ? { status: { in: statuses } } : {}),
      ...(q
        ? {
            OR: [
              { invoiceId: { contains: q, mode: "insensitive" } },
              { msisdn: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: {
          id: true, invoiceId: true, msisdn: true, status: true,
          sellPrice: true, adminFee: true, supplierId: true, supplierRef: true,
          product: { select: { code: true, name: true } },
          createdAt: true, updatedAt: true,
        },
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({
      data: toPlainTxns(rows),
      pagination: { skip, take, total },
    });
  } catch (err) {
    console.error("listTransactions error:", err);
    res.status(500).json({ error: "Gagal mengambil data transaksi." });
  }
}

/**
 * GET /api/transactions/dashboard
 * Mengembalikan ringkasan count per status + 10 transaksi terbaru.
 */
export async function dashboardTransactions(req, res) {
  try {
    const resellerId = req.reseller.id;

    const [counts, latest] = await Promise.all([
      prisma.transaction.groupBy({
        by: ["status"],
        where: { resellerId },
        _count: { _all: true },
      }),
      prisma.transaction.findMany({
        where: { resellerId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true, invoiceId: true, msisdn: true, status: true,
          sellPrice: true, adminFee: true,
          product: { select: { code: true, name: true } },
          createdAt: true, updatedAt: true,
        },
      }),
    ]);

    const summary = {
      PENDING: 0, PROCESSING: 0, SUCCESS: 0, FAILED: 0, REFUNDED: 0, CANCELED: 0, EXPIRED: 0,
    };
    for (const row of counts) {
      summary[row.status] = row._count._all;
    }

    res.json({
      summary,
      latest: toPlainTxns(latest),
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("dashboardTransactions error:", err);
    res.status(500).json({ error: "Gagal mengambil dashboard transaksi." });
  }
}

/**
 * GET /api/transactions/stream  (SSE)
 * Opsional query:
 *  - since=<ISO string>  → hanya kirim perubahan setelah waktu ini
 *  - interval=<ms>       → default 2000 ms
 * Note: SSE satu arah, client auto-refresh UI ketika event diterima.
 */
export async function streamTransactions(req, res) {
  const resellerId = req.reseller.id;
  const intervalMs = Math.max(1000, Math.min(Number(req.query.interval || 2000), 15000));
  let since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 60 * 1000); // default 1 menit terakhir

  // Headers SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let timer = null;
  let closed = false;

  const tick = async () => {
    if (closed) return;
    try {
      const rows = await prisma.transaction.findMany({
        where: {
          resellerId,
          OR: [
            { createdAt: { gt: since } },
            { updatedAt: { gt: since } },
          ],
        },
        orderBy: { updatedAt: "asc" },
        take: 100,
        select: {
          id: true, invoiceId: true, msisdn: true, status: true,
          sellPrice: true, adminFee: true,
          product: { select: { code: true, name: true } },
          createdAt: true, updatedAt: true,
        },
      });

      if (rows.length) {
        // update watermark
        const last = rows[rows.length - 1];
        since = new Date(last.updatedAt);

        const payload = {
          type: "transactions:update",
          since: since.toISOString(),
          items: toPlainTxns(rows),
        };
        res.write(`event: transactions\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } else {
        // heartbeat
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      }
    } catch (err) {
      console.error("SSE tick error:", err);
      res.write(`event: error\ndata: "internal error"\n\n`);
    }
  };

  timer = setInterval(tick, intervalMs);
  // kirim snapshot awal (dashboard + latest)
  (async () => {
    try {
      const [counts, latest] = await Promise.all([
        prisma.transaction.groupBy({
          by: ["status"],
          where: { resellerId },
          _count: { _all: true },
        }),
        prisma.transaction.findMany({
          where: { resellerId },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true, invoiceId: true, msisdn: true, status: true,
            sellPrice: true, adminFee: true,
            product: { select: { code: true, name: true } },
            createdAt: true, updatedAt: true,
          },
        }),
      ]);
      const summary = {
        PENDING: 0, PROCESSING: 0, SUCCESS: 0, FAILED: 0, REFUNDED: 0, CANCELED: 0, EXPIRED: 0,
      };
      for (const row of counts) summary[row.status] = row._count._all;

      res.write(`event: dashboard\n`);
      res.write(`data: ${JSON.stringify({ summary, latest: toPlainTxns(latest) })}\n\n`);
    } catch (err) {
      console.error("SSE initial error:", err);
    }
  })();

  // bersihkan saat client tutup
  req.on("close", () => {
    closed = true;
    if (timer) clearInterval(timer);
    res.end();
  });
}
