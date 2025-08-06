/*
  Warnings:

  - A unique constraint covering the columns `[productId,supplierId]` on the table `SupplierProduct` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "SupplierProduct_supplierId_productId_key";

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_productId_supplierId_key" ON "SupplierProduct"("productId", "supplierId");
