
//api/routes/reseller.js



const express = require("express");
const router = express.Router();


const reseller = require("../controllers/reseller")
router.post("/register", reseller.reseller);

module.exports = router;
