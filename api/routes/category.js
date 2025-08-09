import { Router } from "express";
import {
 bulkMoveProducts,
  upsertCategory,
  listCategories,
  getCategoryById,
  getCategoryProducts,
  deleteCategory,
} from "../controllers/category.js";

const router = Router();

// kategori
router.post("/", upsertCategory);          // create/update by name
router.get("/", listCategories);           // list kategori (dengan total produk)
router.get("/:id", getCategoryById);       // detail kategori
router.get("/:id/products", getCategoryProducts); // list produk per kategori
router.delete("/:id", deleteCategory);     // hapus kategori (opsional, cek relasi dulu)
router.post("/:id/move-products", bulkMoveProducts);
export default router;
