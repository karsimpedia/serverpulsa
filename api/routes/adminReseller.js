// api/routes/adminReseller.js
import { Router } from "express";
import authAdmin from "../middleware/authAdmin.js";
import { createResellerByAdmin } from "../controllers/admin/createResellerByAdmin.js";

const router = Router();

// Hanya admin
router.post("/admin/resellers", authAdmin, createResellerByAdmin);

export default router;
