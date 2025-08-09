// FILE: api/routes/reseller.js

import express from "express"
const routeReseller = express.Router();
import authReseller from "../middleware/authReseller.js";

import { registerReseller, resellerList , updateReseller, deleteReseller, getSaldo, getMutasi, createResellerCallback} from "../controllers/reseller.js";
// Register new reseller
routeReseller.post("/register",registerReseller);

// Get all resellers
routeReseller.get("/", resellerList);
routeReseller.post("/callback",  createResellerCallback);

routeReseller.get("/saldo",authReseller, getSaldo);
routeReseller.get("/mutasi",authReseller, getMutasi);

// Update reseller by ID
routeReseller.put("/:id", updateReseller);




// Delete reseller by ID
routeReseller.delete("/:id", deleteReseller);

export  default routeReseller

