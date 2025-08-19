-- CreateTable
CREATE TABLE "ProductCategoryPrefix" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "length" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategoryPrefix_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductCategoryPrefix_prefix_idx" ON "ProductCategoryPrefix"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategoryPrefix_categoryId_prefix_key" ON "ProductCategoryPrefix"("categoryId", "prefix");

-- AddForeignKey
ALTER TABLE "ProductCategoryPrefix" ADD CONSTRAINT "ProductCategoryPrefix_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
