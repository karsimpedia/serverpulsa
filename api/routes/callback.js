import { Router } from "express";

import { supplierCallbackUniversal } from "../controllers/callback.js";
const router = Router();

router.post("/:supplierCode", supplierCallbackUniversal);
router.get("/:supplierCode",supplierCallbackUniversal);

export default router;
