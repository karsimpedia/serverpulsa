// api/routes/admin.js
import express from 'express';

// Auth & middleware

import { refundTransaction } from "../controllers/refund.js";
// Admin ops lain
import { topupSaldoManual } from '../controllers/saldo.js';
import { createResellerByAdmin } from '../controllers/admin/createResellerByAdmin.js';
import { listTransactions, transactionStats } from '../controllers/monitor.js';
import { upsertSupplierProductsByCategory } from '../controllers/supplierProductCategory.js';
import { authAdmin } from '../middleware/auth.js';


// SUPPLIER (CRUD)
import {
  createSupplier,
  updateSupplier,
  listSuppliers,
} from '../controllers/admin/supplier.controller.js';

// SUPPLIER ENDPOINT (CRUD/TOGGLE/ROTATE)
import {
  createEndpoint,
  updateEndpoint,
  toggleEndpoint,
  rotateEndpointKey,
} from '../controllers/admin/supplierEndpoint.controller.js';

// SUPPLIER PRODUCT – versi ADMIN (by id)
import {
  upsertSupplierProduct as upsertSupplierProductAdmin,
  updateSupplierProduct as updateSupplierProductAdmin,
  toggleSupplierProduct as toggleSupplierProductAdmin,
  bulkUpsertSupplierProducts as bulkUpsertSupplierProductsAdmin,
} from '../controllers/admin/supplierProduct.controller.js';

// SUPPLIER PRODUCT – util publik (by productCode, listing, dsb)
import {
  upsertSupplierProduct as upsertSupplierProductPublic,
  patchSupplierProduct,
  listSupplierProducts,
  bulkUpsertSupplierProducts as bulkUpsertSupplierProductsPublic,
} from '../controllers/supplierProduct.js';

// HEALTHCHECK
import { healthCheckSuppliers } from '../controllers/internal/healthcheck.controller.js';

// SUPPLIER CONFIG (JSON di DB)
import {
  getSupplierConfig,
  upsertSupplierConfig,
  patchSupplierOp,
  testSupplierConfig,
} from '../controllers/admin/supplierConfig.controller.js';

const router = express.Router();
router.use(authAdmin)
/**
 * AUTH
 * - Login admin: no auth
 * - Semua route lain: dilindungi authAdmin
 */


// ===== Reseller/Saldo/Admin tools =====
router.post('/saldo/topup',  topupSaldoManual);
router.post('/resellers',  createResellerByAdmin);

// Monitoring transaksi
router.get('/transactions',  authAdmin , listTransactions);
router.get('/transactions/stats',  transactionStats);

// ===== Supplier (CRUD) =====
router.get('/suppliers', listSuppliers);
router.post('/suppliers',  createSupplier);
router.patch('/suppliers/:id', updateSupplier);

// ===== Supplier Endpoints =====
router.post('/suppliers/:supplierId/endpoints',  createEndpoint);
router.patch('/suppliers/:supplierId/endpoints/:id',  updateEndpoint);
router.post('/suppliers/:supplierId/endpoints/:id/toggle',  toggleEndpoint);
router.post('/suppliers/:supplierId/endpoints/:id/rotate-key',  rotateEndpointKey);

// ===== Supplier Products (ADMIN by internal id) =====
router.post('/suppliers/:supplierId/products',  upsertSupplierProductAdmin);
router.patch('/supplier-products/:id',updateSupplierProductAdmin);
router.post('/supplier-products/:id/toggle',  toggleSupplierProductAdmin);
router.post('/supplier-products/bulk',  bulkUpsertSupplierProductsAdmin);

// ===== Supplier Products (publik utilities by productCode/listing) =====
// gunakan jika admin ingin patch berdasarkan productCode atau operasi kategori
router.post('/suppliers/:supplierId/products/code',  upsertSupplierProductPublic);
router.patch('/suppliers/:supplierId/products/:productCode',  patchSupplierProduct);
router.get('/suppliers/:supplierId/products', listSupplierProducts);
router.post('/suppliers/:supplierId/products/bulk-code',  bulkUpsertSupplierProductsPublic);

router.post(
  '/suppliers/:supplierId/categories/:categoryId/upsert-products',
  
  upsertSupplierProductsByCategory
);

// ===== Supplier Config (JSON di DB) =====
router.get('/suppliers/:id/config',  getSupplierConfig);
router.put('/suppliers/:id/config', upsertSupplierConfig);
router.patch('/suppliers/:code/config/ops/:op',  patchSupplierOp);
router.post('/suppliers/:code/config/test',  testSupplierConfig);

// ===== Healthcheck (cron/internal) =====
// kalau mau dibuka hanya internal, bisa pasang IP allowlist atau secret
router.post('/internal/healthcheck/suppliers',  healthCheckSuppliers);
router.post("/transactions/:id/refund", /* ← tambahkan middleware admin auth kalau ada, */ refundTransaction)
export default router;
