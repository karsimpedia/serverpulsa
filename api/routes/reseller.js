// FILE: api/routes/reseller.js

import express from "express"
const routeReseller = express.Router();
import authReseller from "../middleware/authReseller";
import { setMyReferralCode } from "../controllers/referral.js";
import { RegisTerReseller, resellerList , updateReseller, deleteReseller, getSaldo, getMutasi, createResellerCallback} from "../controllers/reseller";
// Register new reseller
routeReseller.post("/register",RegisTerReseller);

// Get all resellers
routeReseller.get("/", resellerList);
routeReseller.post("/callback",  createResellerCallback);

routeReseller.get("/saldo",authReseller, getSaldo);
routeReseller.get("/mutasi",authReseller, getMutasi);

// Update reseller by ID
routeReseller.put("/:id", updateReseller);
routeReseller.put("/referral/code", setMyReferralCode);



// Delete reseller by ID
routeReseller.delete("/:id", deleteReseller);

export  default routeReseller

