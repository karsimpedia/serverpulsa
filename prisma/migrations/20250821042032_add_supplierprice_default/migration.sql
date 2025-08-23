-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "serial" TEXT,
ADD COLUMN     "supplierPrice" BIGINT NOT NULL DEFAULT 0;
