// api/routes/commission.js
import { Router } from "express";

import {
  getMyCommissionOverview,
  listMyCommissionMutations,
  listMyTransactionCommissions,
  postMyCommissionPayout,
} from "../controllers/commission.js";

const r = Router();



r.get("/me/overview", getMyCommissionOverview);
r.get("/me/mutations", listMyCommissionMutations);
r.get("/me/ledger", listMyTransactionCommissions);
r.post("/me/payout", postMyCommissionPayout);

export default r;
