// api/lib/supplier-registry-db.js
import prisma from '../prisma.js';

const CACHE = new Map(); // key: supplierCode -> { cfg, ts }
const STALE_MS = Number(process.env.SUPPLIER_CONFIG_STALE_MS || 30_000); // default 30s

/**
 * Ambil konfigurasi supplier (defaults, ops, version) dari DB dengan cache singkat.
 * @param {string} supplierCode - kode unik supplier (unik di model Supplier.code)
 * @returns {{defaults: object, ops: object, version: number}}
 */
export async function getSupplierConfigByCode(supplierCode) {
  if (!supplierCode) throw new Error('supplierCode wajib');

  const cached = CACHE.get(supplierCode);
  if (cached && (Date.now() - cached.ts) < STALE_MS) {
    return cached.cfg;
  }

  // Ambil config langsung dari relasi 'config'
  const sup = await prisma.supplier.findUnique({
    where: { code: supplierCode },
    select: {
      status: true,
      config: {
        select: {
          defaults: true,
          ops: true,
          version: true,
        },
      },
    },
  });

  if (!sup) throw new Error(`Supplier ${supplierCode} tidak ditemukan`);
  if (!sup.config) throw new Error(`Config untuk supplier ${supplierCode} belum diatur`);
  if (sup.status !== 'ACTIVE') throw new Error(`Supplier ${supplierCode} tidak aktif`);

  const cfg = {
    defaults: sup.config.defaults ?? {},
    ops: sup.config.ops ?? {},
    version: sup.config.version ?? 1,
  };

  CACHE.set(supplierCode, { cfg, ts: Date.now() });
  return cfg;
}

/**
 * Invalidasi cache per supplier (panggil setelah update config).
 * @param {string} supplierCode
 */
export function invalidateSupplierConfigCache(supplierCode) {
  if (!supplierCode) return;
  CACHE.delete(supplierCode);
}

/**
 * Optional: invalidasi semua supplier (misal setelah batch update).
 */
export function invalidateAllSupplierConfigCache() {
  CACHE.clear();
}
