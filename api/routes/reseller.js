// FILE: api/routes/reseller.js

import express from "express";
const routeReseller = express.Router();
import { authAdmin } from "../middleware/auth.js";

import {
  resellerList,
  updateReseller,
  deleteReseller,
  getSaldo,
  getMutasi,
  createResellerCallback,
  getReseller,
} from "../controllers/reseller.js";

routeReseller.get("/:id", authAdmin, getReseller);
routeReseller.patch("/:id", authAdmin, updateReseller);
// Get all resellers
routeReseller.get("/", authAdmin, resellerList);
// routeReseller.post("/callback",  createResellerCallback);

routeReseller.get("/saldo/:id", authAdmin, getSaldo);
routeReseller.get("/mutasi/:id", authAdmin, getMutasi);

// Update reseller by ID
routeReseller.put("/:id", authAdmin, updateReseller);

// Delete reseller by ID
routeReseller.delete("/:id", authAdmin, deleteReseller);

export default routeReseller;
