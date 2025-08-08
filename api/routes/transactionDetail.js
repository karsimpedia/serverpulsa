// api/routes/transactionDetail.js
import express from "express";
import authReseller from "../middleware/authReseller.js";
import { getTransactionByInvoice } from "../controllers/transactionDetail.js";

const router = express.Router();
router.get("/:invoiceId", authReseller, getTransactionByInvoice);

export default router;
