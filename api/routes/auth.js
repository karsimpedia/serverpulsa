import { Router } from "express";
import { loginReseller, me, logout, loginAdmin } from "../controllers/auth.js";


const router = Router();

router.post("/admin/login", loginAdmin);
router.get("/me",  me);
router.post("/logout",  logout);

export default router;
