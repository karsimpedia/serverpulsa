
//api/routes/product.js



const express = require("express");
const router = express.Router();
const product= require("../controllers/product")

const reseller = require("../controllers/reseller")
router.post("/add-product",product.Addproduct);

module.exports = router;