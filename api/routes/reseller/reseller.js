//routes/reseller/resellerjs

import { Router } from "express";
import { authReseller } from "../../middleware/auth.js";
import { loginReseller , me, logout } from "../../controllers/auth.js";
import { resellerPriceList } from "../../controllers/myEffectivePrice.js";
import { getMutasibyReseller, listTransactions, listMyDownlines } from "../../controllers/reseller.js";
import { getTransactionDetail } from "../../controllers/transactionDetail.js";
import { setDownlineGlobalMarkup } from "../../controllers/resellerMarkup.js";
const router = Router()

router.post("/login", loginReseller )
router.get("/logout", logout )
router.get("/me", authReseller,  me)
router.post("/set-markup/:downlineId", authReseller,  setDownlineGlobalMarkup)
router.get("/list-downline", authReseller,  listMyDownlines)
router.get("/price-list", authReseller,  resellerPriceList)
router.get("/mutasi-saldo", authReseller,  getMutasibyReseller)
router.get("/transactions-list", authReseller,  listTransactions)
router.get("/transactions-detail/:idOrInvoice", authReseller,  getTransactionDetail)

export default router
