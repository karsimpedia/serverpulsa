const express = require("express");
const router = express.Router();


const apitopup = require("../controllers/topup")
router.post("/topup", apitopup.topup);

module.exports = router;
