// api/routes/transaction.js
import express from "express";
import authReseller from "../middleware/authReseller.js";
import {
  listTransactions,
  dashboardTransactions,
  streamTransactions,
} from "../controllers/transaction.js";

const router = express.Router();

// Dashboard ringkas (counts + latest)
router.get("/dashboard", authReseller, dashboardTransactions);

// List transaksi (filter, paging)
router.get("/", authReseller, listTransactions);

// SSE stream untuk auto refresh dashboard
router.get("/stream", authReseller, streamTransactions);

export default router;
