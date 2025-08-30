-- CreateEnum
CREATE TYPE "RedeemStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "pointValue" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "pointAwarded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pointGiven" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pointReversed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TransactionPoint" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerPoint" (
    "resellerId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ResellerPoint_pkey" PRIMARY KEY ("resellerId")
);

-- CreateTable
CREATE TABLE "PointRedemption" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "description" TEXT,
    "status" "RedeemStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionPoint_transactionId_key" ON "TransactionPoint"("transactionId");

-- AddForeignKey
ALTER TABLE "TransactionPoint" ADD CONSTRAINT "TransactionPoint_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionPoint" ADD CONSTRAINT "TransactionPoint_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionPoint" ADD CONSTRAINT "TransactionPoint_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerPoint" ADD CONSTRAINT "ResellerPoint_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRedemption" ADD CONSTRAINT "PointRedemption_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
