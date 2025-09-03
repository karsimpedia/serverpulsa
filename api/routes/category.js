import { Router } from "express";
import {
 bulkMoveProducts,
  upsertCategory,
  listCategories,
  getCategoryById,
  getCategoryProducts,
  deleteCategory,
  listCategoriesByPrefix,
updateCategoryById,
  listCategoryPrefixes,
  bulkAddCategoryPrefixes,
  replaceCategoryPrefixes,
  deleteCategoryPrefix
} from "../controllers/category.js";
import { authAdmin } from "../middleware/auth.js";
const router = Router();

router.use( authAdmin)
// kategori
router.post("/", upsertCategory);  // create/update by name
router.patch("/:id", updateCategoryById);   //update category by id      
router.get("/", listCategories);           // list kategori (dengan total produk)
router.get("/byid/:id", getCategoryById);       // detail kategori
router.get("/:id/products", getCategoryProducts); // list produk per kategori
router.delete("/:id", deleteCategory);     // hapus kategori (opsional, cek relasi dulu)
router.post("/:id/move-products", bulkMoveProducts);


// prefix kategori (baru)
router.get("/bymsisdn", listCategoriesByPrefix);
router.get("/:id/prefixes", listCategoryPrefixes);
router.post("/:id/prefixes/bulk", bulkAddCategoryPrefixes);
router.put("/:id/prefixes", replaceCategoryPrefixes);
router.delete("/:id/prefixes/:prefixId", deleteCategoryPrefix);
export default router;
