// api/routes/monitor.js
import { Router } from "express";
import { listTransactions, transactionStats } from "../controllers/monitor.js";

const router = Router();

// NOTE: ganti middleware sesuai kebutuhan (admin-only)
router.get("/transactions", /* authAdmin? */ listTransactions);
router.get("/transactions/stats", /* authAdmin? */ transactionStats);

export default router;
