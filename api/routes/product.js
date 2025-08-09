
//api/routes/product.js

import express from "express"
const routerProduct = express.Router();

import { createProduct, getAllProducts, getProduct, updateProduct, deleteProduct, upsertProduct} from "../controllers/product.js";
routerProduct.post("/", createProduct);
routerProduct.post("/upsert", upsertProduct);
routerProduct.get("/",getAllProducts);
routerProduct.get("/:id",getProduct);
routerProduct.put("/:id", updateProduct);
routerProduct.delete("/:id", deleteProduct);

export  default routerProduct;
