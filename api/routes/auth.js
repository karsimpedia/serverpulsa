import { Router } from "express";
import { loginReseller, me, logout, loginAdmin, refresh } from "../controllers/auth.js";


const router = Router();

router.post("/admin/login", loginAdmin);
router.post("/refresh", refresh);
router.get("/me",  me);
router.post("/logout",  logout);

export default router;
