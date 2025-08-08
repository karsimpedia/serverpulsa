// api/routes/referral.js
import express from "express";
import authReseller from "../middleware/authReseller.js";
import { updateMyReferralCode } from "../controllers/referral.js";

const router = express.Router();

// Ganti referral code milik sendiri
router.put("/code", authReseller, updateMyReferralCode);

export default router;
