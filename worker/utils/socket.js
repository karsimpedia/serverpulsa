// worker/utils/socket.js
import axios from "axios";
import prisma from "../../api/prisma.js";

const REALTIME_ENDPOINT =
  process.env.REALTIME_ENDPOINT || "http://localhost:3000/api/admin/broadcast-trx";

// Build payload lengkap dari DB (tanpa include relasi yang tidak ada)
async function buildTrxPayload(trxId, overrides = {}) {
  // Ambil transaksi + relasi product (untuk code)
  const trx = await prisma.transaction.findUnique({
    where: { id: trxId },
    include: { product: { select: { code: true } } }
  });

  if (!trx) return { id: trxId, ...overrides };

  // Ambil supplierName via Supplier (karena Transaction tidak punya relasi supplier)
  let supplierName = null;
  if (trx.supplierId) {
    const s = await prisma.supplier.findUnique({
      where: { id: trx.supplierId },
      select: { name: true }
    });
    supplierName = s?.name ?? null;
  }

  return {
    id: trx.id,
    invoiceId: trx.invoiceId,
    resellerId: trx.resellerId,
    productCode: trx.product?.code ?? null,
    msisdn: trx.msisdn,
    // amount yang ditampilkan di UI = harga jual (sellPrice)
    amount: Number(trx.sellPrice ?? 0),
    status: overrides.status ?? trx.status,
    supplierName,
    message: overrides.message ?? trx.message ?? null,
    createdAt: trx.createdAt
  };
}

export async function pushTrxUpdate(trxId, payload = {}) {
  try {
    const body = await buildTrxPayload(trxId, payload);
    await axios.post(REALTIME_ENDPOINT, body, { timeout: 5000 });
  } catch (e) {
    console.log("[socket-fallback] trx:update", trxId, payload, "| err:", e?.message || e);
  }
}
