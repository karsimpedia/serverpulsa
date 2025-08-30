
//api/routes/product.js

import express from "express"
const routerProduct = express.Router();
import { listEffectivePriceForDownlines } from "../controllers/product.js";
import { createProduct, getAllProducts, getProduct, updateProduct, deleteProduct, upsertProduct, setProductPoint, getProductByCode} from "../controllers/product.js";
import { listMyEffectivePrice } from "../controllers/myEffectivePrice.js";
routerProduct.get("/effective-price", listEffectivePriceForDownlines);
routerProduct.get("/harga/me", listMyEffectivePrice);
routerProduct.post("/", createProduct);
routerProduct.post("/upsert", upsertProduct);
routerProduct.post("/setpoint", setProductPoint );
routerProduct.get("/",getAllProducts);
routerProduct.get("/:id",getProduct);
routerProduct.get("/bycode/:code",getProductByCode);
routerProduct.put("/:id", updateProduct);
routerProduct.delete("/:id", deleteProduct);


export  default routerProduct;
