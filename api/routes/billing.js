// api/routes/billing.js
import express from "express";
import authReseller from "../middleware/authReseller.js";
import { inquiryOnly, payBill, inquiryBill } from "../controllers/billing.js";

const router = express.Router();
router.post("/inquiry", authReseller, inquiryOnly);
router.post("/pay", authReseller, payBill);
export default router;
