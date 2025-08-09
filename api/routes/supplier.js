import express from "express";
const routerSuplier = express.Router();

import {
  createSupplier,
  getAllSuppliers,
  getSupplierById,
  updateSupplier,
  deleteSupplier,
  supplierCallback,
} from "../controllers/supplier.js";


routerSuplier.post("/callback/:supplierCode", supplierCallback);
routerSuplier.post("/", createSupplier);
routerSuplier.get("/", getAllSuppliers);
routerSuplier.get("/:id", getSupplierById);
routerSuplier.put("/:id", updateSupplier);
routerSuplier.delete("/:id", deleteSupplier);

export default routerSuplier;
