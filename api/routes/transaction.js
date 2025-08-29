// api/routes/transaction.js
import express from "express";

import {
  listTransactions,
  dashboardTransactions,
  streamTransactions,
} from "../controllers/transaction.js";

const router = express.Router();

// Dashboard ringkas (counts + latest)
router.get("/dashboard", dashboardTransactions);

// List transaksi (filter, paging)
router.get("/",  listTransactions);

// SSE stream untuk auto refresh dashboard
router.get("/stream",  streamTransactions);

export default router;
