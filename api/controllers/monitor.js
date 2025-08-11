// api/controllers/monitor.js
import prisma from "../prisma.js";

/* Utils */
const toInt = (v, d = 1) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const ALLOWED_SORT = new Set(["createdAt", "updatedAt", "sellPrice"]);
const safeSort = (s) => (ALLOWED_SORT.has(s) ? s : "createdAt");

/**
 * GET /api/admin/transactions
 * Query: page, pageSize|limit, status, search(msisdn|invoiceId|product.code), dateFrom, dateTo, sort, order
 */
export async function listTransactions(req, res) {
  try {
    const page = toInt(req.query.page, 1);
    const pageSize = toInt(req.query.pageSize || req.query.limit, 50);
    const status = req.query.status?.toUpperCase();
    const search = (req.query.search || "").trim();
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const dateTo = req.query.dateTo ? new Date(req.query.dateTo) : null;
    const sort = safeSort(req.query.sort || "createdAt");
    const order = (req.query.order || "desc").toLowerCase() === "asc" ? "asc" : "desc";

    // Cari productId yang code-nya match (tanpa mengandalkan relasi di where)
    let productIdsByCode = [];
    if (search) {
      try {
        const prods = await prisma.product.findMany({
          where: { code: { contains: search, mode: "insensitive" } },
          select: { id: true },
          take: 1000,
        });
        productIdsByCode = prods.map((p) => p.id);
      } catch {
        productIdsByCode = [];
      }
    }

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { msisdn: { contains: search, mode: "insensitive" } },
        { invoiceId: { contains: search, mode: "insensitive" } },
      ];
      if (productIdsByCode.length) where.OR.push({ productId: { in: productIdsByCode } });
    }
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = dateFrom;
      if (dateTo) where.createdAt.lte = dateTo;
    }

    const [total, rows] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { [sort]: order },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          invoiceId: true,
          resellerId: true,
          supplierId: true,   // hanya ID — nama di-lookup di bawah
          productId: true,
          msisdn: true,
          sellPrice: true,    // BigInt
          adminFee: true,     // BigInt
          status: true,
        //   message: true,
          createdAt: true,
          updatedAt: true,
          product: { select: { code: true } }, // relasi product ada di model kamu
        },
      }),
    ]);

    // Lookup nama supplier berdasarkan supplierId (karena tdk ada relasi di model)
    const supplierIds = [...new Set(rows.map((r) => r.supplierId).filter(Boolean))];
    let supplierMap = {};
    if (supplierIds.length) {
      try {
        const sups = await prisma.supplier.findMany({
          where: { id: { in: supplierIds } },
          select: { id: true, name: true },
        });
        supplierMap = Object.fromEntries(sups.map((s) => [s.id, s.name]));
      } catch {
        supplierMap = {};
      }
    }

    const data = rows.map((r) => ({
      id: r.id,
      invoiceId: r.invoiceId,
      resellerId: r.resellerId,
      supplierId: r.supplierId,
      supplierName: supplierMap[r.supplierId] ?? null,
      productCode: r.product?.code ?? null,
      msisdn: r.msisdn,
      // kirim sebagai number agar mudah dipakai UI (BigInt -> Number)
      amount: Number(r.sellPrice ?? 0),
      price: Number(r.sellPrice ?? 0),
      adminFee: Number(r.adminFee ?? 0),
      status: r.status,
      message: r.message ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    res.json({ page, pageSize, total, pages: Math.ceil(total / pageSize), data });
  } catch (err) {
    console.error("listTransactions error:", err);
    res.status(500).json({ error: "Gagal memuat transaksi." });
  }
}

/**
 * GET /api/admin/transactions/stats
 * Query opsional: dateFrom, dateTo
 */
export async function transactionStats(req, res) {
  try {
    const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const dateTo = req.query.dateTo ? new Date(req.query.dateTo) : null;

    const where = {};
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = dateFrom;
      if (dateTo) where.createdAt.lte = dateTo;
    }

    // Hitung jumlah per status
    const grouped = await prisma.transaction.groupBy({
      by: ["status"],
      _count: { _all: true },
      where,
    });

    const counts = {
      PENDING: 0,
      PROCESSING: 0,
      SUCCESS: 0,
      FAILED: 0,
      REFUNDED: 0,
      CANCELED: 0,
      EXPIRED: 0,
      OTHER: 0,
    };
    for (const g of grouped) {
      if (counts[g.status] !== undefined) counts[g.status] = g._count._all;
      else counts.OTHER += g._count._all;
    }

    // Statistik hari ini
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [totalToday, successToday] = await Promise.all([
      prisma.transaction.count({ where: { createdAt: { gte: startToday } } }),
      prisma.transaction.aggregate({
        where: { createdAt: { gte: startToday }, status: "SUCCESS" },
        _sum: { sellPrice: true, adminFee: true },
      }),
    ]);

    res.json({
      counts,
      today: {
        total: totalToday,
        sumPrice: Number(successToday._sum.sellPrice || 0),
        sumAdminFee: Number(successToday._sum.adminFee || 0),
      },
      range: { dateFrom, dateTo },
    });
  } catch (err) {
    console.error("transactionStats error:", err);
    res.status(500).json({ error: "Gagal memuat statistik." });
  }
}

/* Dipakai bridge Redis → Socket.IO */
export async function emitStats(ioOrNamespace) {
  const grouped = await prisma.transaction.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const counts = grouped.reduce((acc, g) => {
    acc[g.status] = g._count._all;
    return acc;
  }, {});
  try {
    ioOrNamespace.to("admin").emit("stats:update", { counts });
  } catch (e) {
    console.error("emitStats emit error:", e?.message || e);
  }
  return { counts };
}
