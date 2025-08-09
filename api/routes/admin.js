// api/routes/admin.js
import express from "express";
import { topupSaldoManual } from "../controllers/saldo.js";
import { loginAdmin } from "../controllers/auth.js";
import { authAdmin } from "../middleware/authAdmin.js";
import { upsertSupplierProductsByCategory } from "../controllers/supplierProductCategory.js";

import {
  upsertSupplierProduct,
  patchSupplierProduct,
  listSupplierProducts,
  bulkUpsertSupplierProducts,
} from "../controllers/supplierProduct.js";

const router = express.Router();

router.post("/saldo/topup", topupSaldoManual);
router.post("/login",  loginAdmin );
router.post("/suppliers/:supplierId/products", upsertSupplierProduct);
router.patch("/suppliers/:supplierId/products/:productCode", patchSupplierProduct);
router.get("/suppliers/:supplierId/products", listSupplierProducts);
router.post("/suppliers/:supplierId/products/bulk", bulkUpsertSupplierProducts);
router.post(
  "/suppliers/:supplierId/categories/:categoryId/upsert-products",
  upsertSupplierProductsByCategory
);


export default router;
