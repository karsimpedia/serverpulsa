//api/routes/commission.js

import express from "express";
const routerCommisson = express.Router();
import {
  listMyCommissionRules,
  upsertMyCommissionRule,
  deleteMyCommissionRule,
} from "../controllers/commission.js";

routerCommisson.get("/", listMyCommissionRules);
routerCommisson.post("/", upsertMyCommissionRule);
routerCommisson.delete("/", deleteMyCommissionRule);

export default routerCommisson;
