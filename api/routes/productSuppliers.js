// api/routes/productSuppliers.js
import { Router } from "express";
import {
  listSupplierProducts,
  createSupplierProduct,
  updateSupplierProduct,
  deleteSupplierProduct,
} from "../controllers/productSupplier.controller.js";

const router = Router();

router.get("/", listSupplierProducts);
router.post("/", createSupplierProduct);        // ?mode=upsert opsional
router.patch("/:id", updateSupplierProduct);
router.delete("/:id", deleteSupplierProduct);

export default router;
