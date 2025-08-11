// api/routes/monitor.js
import { Router } from "express";
import { listTransactions, transactionStats } from "../controllers/monitor.js";
import authReseller from "../middleware/authReseller.js"; // jika perlu proteksi admin, ganti dengan authAdmin

const router = Router();

// NOTE: ganti middleware sesuai kebutuhan (admin-only)
router.get("/transactions", /* authAdmin? */ listTransactions);
router.get("/transactions/stats", /* authAdmin? */ transactionStats);

export default router;
