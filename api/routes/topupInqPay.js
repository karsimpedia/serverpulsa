// api/routes/billing.js
import express from "express";
import { getTransactionByInvoice } from "../controllers/transactionDetail.js";
const router = express.Router();
import authReseller from "../middleware/authReseller.js";
import { inquiryOnly, payBill, inquiryBill } from "../controllers/billing.js";
import { createTopup } from "../controllers/topup.js";
router.get("/:invoiceId", getTransactionByInvoice)
router.post("/inquiry",  inquiryOnly);
router.post("/pay",  payBill);
router.post("/topup",  createTopup);
export default router;
