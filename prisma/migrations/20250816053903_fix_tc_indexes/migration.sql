/*
  Warnings:

  - A unique constraint covering the columns `[transactionId,resellerId,level]` on the table `TransactionCommission` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateTable
CREATE TABLE "CommissionBalance" (
    "resellerId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "CommissionBalance_pkey" PRIMARY KEY ("resellerId")
);

-- CreateTable
CREATE TABLE "CommissionMutation" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "transactionId" TEXT,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "beforeAmount" BIGINT NOT NULL,
    "afterAmount" BIGINT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionMutation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPayout" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "approverId" TEXT,

    CONSTRAINT "CommissionPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionMutation_resellerId_createdAt_idx" ON "CommissionMutation"("resellerId", "createdAt");

-- CreateIndex
CREATE INDEX "CommissionPayout_resellerId_status_createdAt_idx" ON "CommissionPayout"("resellerId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionCommission_transactionId_resellerId_level_key" ON "TransactionCommission"("transactionId", "resellerId", "level");

-- AddForeignKey
ALTER TABLE "CommissionBalance" ADD CONSTRAINT "CommissionBalance_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionMutation" ADD CONSTRAINT "CommissionMutation_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionMutation" ADD CONSTRAINT "CommissionMutation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
