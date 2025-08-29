// api/routes/referral.js
import express from "express";

import { updateMyReferralCode } from "../controllers/referral.js";

const router = express.Router();

// Ganti referral code milik sendiri
router.put("/code",  updateMyReferralCode);

export default router;
