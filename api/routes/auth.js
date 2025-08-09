import { Router } from "express";
import { loginReseller, me, logout } from "../controllers/auth.js";
import { authJwt } from "../middleware/authJwt.js";

const router = Router();

router.post("/login", loginReseller);
router.get("/me", authJwt, me);
router.post("/logout", authJwt, logout);

export default router;
