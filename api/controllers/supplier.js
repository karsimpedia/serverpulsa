

import prisma from "../prisma.js";
/**
 * Controller for Supplier CRUD operations
 */

// Add a new supplier
export const createSupplier = async (req, res) => {
  try {
    const { name, apiUrl, apiKey, status = true } = req.body;
    if (!name || !apiUrl || !apiKey) {
      return res
        .status(400)
        .json({ error: "Fields name, apiUrl, and apiKey are required." });
    }
    const supplier = await prisma.supplier.create({
      data: { name, apiUrl, apiKey, status },
    });
    res.status(201).json({ message: "Supplier created", supplier });
  } catch (err) {
    console.error("Create supplier error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Get all suppliers
export const getAllSuppliers = async (req, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: suppliers });
  } catch (err) {
    console.error("Fetch suppliers error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Get a single supplier by ID


// util untuk masking kredensial
function mask(s = "", left = 4, right = 2) {
  const str = String(s || "");
  if (!str) return "";
  if (str.length <= left + right) return "*".repeat(Math.max(str.length, 4));
  return str.slice(0, left) + "*".repeat(str.length - left - right) + str.slice(-right);
}

// Get a single supplier by ID + endpoints + config
export const getSupplierById = async (req, res) => {
  try {
    const { id } = req.params;
    // opsi: ?revealSecrets=1 buat admin (kalau kamu sudah punya auth/role)
    const reveal = String(req.query.revealSecrets || "") === "1";

    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: {
        endpoints: {
          select: {
            id: true,
            name: true,
            baseUrl: true,
            apiKey: true,
            secret: true,
            isActive: true,
            // tambahkan field lain kalau ada, mis. headers, timeoutMs, dsb
          },
          orderBy: { name: "asc" },
        },
        config: true, // ambil record config (mis. ops, defaults, statusAlias, dsb)
      },
    });

    if (!supplier) {
      return res.status(404).json({ error: "Supplier not found." });
    }

    // siapkan payload aman (masking kunci)
    const endpoints = (supplier.endpoints || []).map((e) => ({
      id: e.id,
      name: e.name,
      baseUrl: e.baseUrl,
      isActive: e.isActive,
      apiKey: reveal ? e.apiKey : mask(e.apiKey),
      secret: reveal ? e.secret : mask(e.secret),
    }));

    // jika SupplierConfig menyimpan JSON (mis. field `data`), parse-kan
    // sesuaikan dengan skema kamu; contoh di bawah:
    let config = supplier.config || null;
    if (config && typeof config.data === "string") {
      try {
        config = { ...config, data: JSON.parse(config.data) };
      } catch {
        // biarkan apa adanya kalau gagal parse
      }
    }

    return res.json({
      data: {
        id: supplier.id,
        name: supplier.name,
        code: supplier.code,
        status: supplier.status,
        createdAt: supplier.createdAt,
        updatedAt: supplier.updatedAt,
        endpoints,
        config, // berisi konfigurasi supplier (ops, mapping callback, defaults, dll.)
      },
    });
  } catch (err) {
    console.error("Fetch supplier error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
};


// Update a supplier
export const updateSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, apiUrl, apiKey, status } = req.body;
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing)
      return res.status(404).json({ error: "Supplier not found." });

    const supplier = await prisma.supplier.update({
      where: { id },
      data: { name, apiUrl, apiKey, status },
    });
    res.json({ message: "Supplier updated", supplier });
  } catch (err) {
    console.error("Update supplier error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

// Delete a supplier
export const deleteSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing)
      return res.status(404).json({ error: "Supplier not found." });

    await prisma.supplier.delete({ where: { id } });
    res.json({ message: "Supplier deleted" });
  } catch (err) {
    console.error("Delete supplier error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};


// Callback dari supplier, contoh payload { supplierRef, status: 'SUCCESS'|'FAILED', message? }
export async function supplierCallback(req, res) {
  const { supplierCode } = req.params;
  const supplier = await prisma.supplier.findUnique({ where: { code: supplierCode } });
  if (!supplier) return res.status(404).json({ error: 'Supplier tidak ditemukan' });

  const { supplierRef, status } = req.body || {};
  if (!supplierRef) return res.status(400).json({ error: 'supplierRef wajib' });

  const trx = await prisma.transaction.findFirst({ where: { supplierId: supplier.id, supplierRef } });
  if (!trx) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

  const newStatus = (status === 'SUCCESS') ? 'SUCCESS' : 'FAILED';
  await prisma.transaction.update({
    where: { id: trx.id },
    data: { status: newStatus, supplierResult: req.body },
  });

  await trxQueue.add('settlement', { trxId: trx.id }, { removeOnComplete: true, removeOnFail: true });

  res.json({ ok: true });
}