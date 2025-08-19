/*
  Warnings:

  - You are about to drop the column `relatedTo` on the `MutasiSaldo` table. All the data in the column will be lost.
  - You are about to alter the column `amount` on the `MutasiSaldo` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `BigInt`.
  - You are about to alter the column `basePrice` on the `Product` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `BigInt`.
  - You are about to drop the column `markupDefault` on the `Reseller` table. All the data in the column will be lost.
  - You are about to drop the column `password` on the `Reseller` table. All the data in the column will be lost.
  - You are about to drop the column `saldo` on the `Reseller` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `Reseller` table. All the data in the column will be lost.
  - You are about to drop the column `apiKey` on the `Supplier` table. All the data in the column will be lost.
  - You are about to drop the column `apiUrl` on the `Supplier` table. All the data in the column will be lost.
  - The `status` column on the `Supplier` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `isPrimary` on the `SupplierProduct` table. All the data in the column will be lost.
  - You are about to drop the column `kodeSupplier` on the `SupplierProduct` table. All the data in the column will be lost.
  - You are about to drop the `HargaJual` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ResellerDevice` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Topup` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[userId]` on the table `Reseller` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[referralCode]` on the table `Reseller` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[code]` on the table `Supplier` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[supplierId,productId]` on the table `SupplierProduct` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `afterAmount` to the `MutasiSaldo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `beforeAmount` to the `MutasiSaldo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source` to the `MutasiSaldo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `trxId` to the `MutasiSaldo` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `type` on the `MutasiSaldo` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `type` on the `Product` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `apiKeyHash` to the `Reseller` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Reseller` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `Reseller` table without a default value. This is not possible if the table is not empty.
  - Added the required column `code` to the `Supplier` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Supplier` table without a default value. This is not possible if the table is not empty.
  - Added the required column `costPrice` to the `SupplierProduct` table without a default value. This is not possible if the table is not empty.
  - Added the required column `supplierSku` to the `SupplierProduct` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `SupplierProduct` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'RESELLER');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('PULSA', 'TAGIHAN');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REFUNDED', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('TOPUP', 'TAGIHAN_INQUIRY', 'TAGIHAN_PAY');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('API', 'IP', 'PHONE', 'APP_ID', 'UUID');

-- CreateEnum
CREATE TYPE "MutasiType" AS ENUM ('CREDIT', 'DEBIT', 'REFUND', 'ADJUST');

-- CreateEnum
CREATE TYPE "MutasiStatus" AS ENUM ('SUCCESS', 'FAILED', 'PENDING');

-- CreateEnum
CREATE TYPE "CommissionValueType" AS ENUM ('AMOUNT', 'PERCENT');

-- CreateEnum
CREATE TYPE "CommissionBase" AS ENUM ('SELLPRICE', 'MARGIN');

-- DropForeignKey
ALTER TABLE "HargaJual" DROP CONSTRAINT "HargaJual_productId_fkey";

-- DropForeignKey
ALTER TABLE "HargaJual" DROP CONSTRAINT "HargaJual_resellerId_fkey";

-- DropForeignKey
ALTER TABLE "ResellerDevice" DROP CONSTRAINT "ResellerDevice_resellerId_fkey";

-- DropForeignKey
ALTER TABLE "Topup" DROP CONSTRAINT "Topup_productId_fkey";

-- DropForeignKey
ALTER TABLE "Topup" DROP CONSTRAINT "Topup_resellerId_fkey";

-- DropIndex
DROP INDEX "Reseller_username_key";

-- DropIndex
DROP INDEX "SupplierProduct_productId_supplierId_key";

-- AlterTable
ALTER TABLE "MutasiSaldo" DROP COLUMN "relatedTo",
ADD COLUMN     "afterAmount" BIGINT NOT NULL,
ADD COLUMN     "beforeAmount" BIGINT NOT NULL,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "source" TEXT NOT NULL,
ADD COLUMN     "status" "MutasiStatus" NOT NULL DEFAULT 'SUCCESS',
ADD COLUMN     "trxId" TEXT NOT NULL,
ALTER COLUMN "amount" SET DATA TYPE BIGINT,
DROP COLUMN "type",
ADD COLUMN     "type" "MutasiType" NOT NULL;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "margin" BIGINT NOT NULL DEFAULT 0,
DROP COLUMN "type",
ADD COLUMN     "type" "ProductType" NOT NULL,
ALTER COLUMN "nominal" DROP NOT NULL,
ALTER COLUMN "basePrice" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "Reseller" DROP COLUMN "markupDefault",
DROP COLUMN "password",
DROP COLUMN "saldo",
DROP COLUMN "username",
ADD COLUMN     "apiKeyHash" TEXT NOT NULL,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "levelCache" INTEGER,
ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "userId" TEXT NOT NULL,
ALTER COLUMN "pin" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Supplier" DROP COLUMN "apiKey",
DROP COLUMN "apiUrl",
ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "SupplierProduct" DROP COLUMN "isPrimary",
DROP COLUMN "kodeSupplier",
ADD COLUMN     "costPrice" BIGINT NOT NULL,
ADD COLUMN     "isAvailable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "supplierSku" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- DropTable
DROP TABLE "HargaJual";

-- DropTable
DROP TABLE "ResellerDevice";

-- DropTable
DROP TABLE "Topup";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'RESELLER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerChannel" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "value" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResellerChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Saldo" (
    "resellerId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "Saldo_pkey" PRIMARY KEY ("resellerId")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierConfig" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "defaults" JSONB,
    "ops" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierEndpoint" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT,
    "secret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHealthAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastLatencyMs" INTEGER,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SupplierEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerCallback" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResellerCallback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "msisdn" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL DEFAULT 'TOPUP',
    "sellPrice" BIGINT NOT NULL,
    "adminFee" BIGINT NOT NULL DEFAULT 0,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "supplierId" TEXT,
    "supplierRef" TEXT,
    "supplierPayload" JSONB,
    "supplierResult" JSONB,
    "callbackSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "externalRefId" TEXT,
    "message" TEXT,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerMarkup" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "markup" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ResellerMarkup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "base" "CommissionBase" NOT NULL DEFAULT 'MARGIN',
    "maxLevels" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "valueType" "CommissionValueType" NOT NULL,
    "value" BIGINT NOT NULL,
    "productId" TEXT,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPlanAssignment" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,

    CONSTRAINT "CommissionPlanAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionCommission" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResellerPrice" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sellPrice" BIGINT NOT NULL,

    CONSTRAINT "ResellerPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionFlat" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionFlat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierHealthLog" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "message" TEXT,

    CONSTRAINT "SupplierHealthLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Device_identifier_key" ON "Device"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "ResellerChannel_resellerId_type_value_key" ON "ResellerChannel"("resellerId", "type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_name_key" ON "ProductCategory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_code_key" ON "ProductCategory"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierConfig_supplierId_key" ON "SupplierConfig"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_invoiceId_key" ON "Transaction"("invoiceId");

-- CreateIndex
CREATE INDEX "Transaction_resellerId_productId_msisdn_createdAt_idx" ON "Transaction"("resellerId", "productId", "msisdn", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_resellerId_externalRefId_key" ON "Transaction"("resellerId", "externalRefId");

-- CreateIndex
CREATE UNIQUE INDEX "ResellerMarkup_resellerId_productId_key" ON "ResellerMarkup"("resellerId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionRule_planId_level_productId_key" ON "CommissionRule"("planId", "level", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionPlanAssignment_resellerId_key" ON "CommissionPlanAssignment"("resellerId");

-- CreateIndex
CREATE INDEX "TransactionCommission_transactionId_idx" ON "TransactionCommission"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ResellerPrice_resellerId_productId_key" ON "ResellerPrice"("resellerId", "productId");

-- CreateIndex
CREATE INDEX "CommissionFlat_resellerId_level_idx" ON "CommissionFlat"("resellerId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionFlat_resellerId_level_productId_key" ON "CommissionFlat"("resellerId", "level", "productId");

-- CreateIndex
CREATE INDEX "SupplierHealthLog_endpointId_checkedAt_idx" ON "SupplierHealthLog"("endpointId", "checkedAt");

-- CreateIndex
CREATE INDEX "MutasiSaldo_resellerId_createdAt_idx" ON "MutasiSaldo"("resellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reseller_userId_key" ON "Reseller"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Reseller_referralCode_key" ON "Reseller"("referralCode");

-- CreateIndex
CREATE INDEX "Reseller_parentId_idx" ON "Reseller"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_code_key" ON "Supplier"("code");

-- CreateIndex
CREATE INDEX "SupplierProduct_productId_isAvailable_priority_idx" ON "SupplierProduct"("productId", "isAvailable", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_supplierId_productId_key" ON "SupplierProduct"("supplierId", "productId");

-- AddForeignKey
ALTER TABLE "Reseller" ADD CONSTRAINT "Reseller_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerChannel" ADD CONSTRAINT "ResellerChannel_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Saldo" ADD CONSTRAINT "Saldo_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierConfig" ADD CONSTRAINT "SupplierConfig_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierEndpoint" ADD CONSTRAINT "SupplierEndpoint_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerCallback" ADD CONSTRAINT "ResellerCallback_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerMarkup" ADD CONSTRAINT "ResellerMarkup_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerMarkup" ADD CONSTRAINT "ResellerMarkup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CommissionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlanAssignment" ADD CONSTRAINT "CommissionPlanAssignment_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlanAssignment" ADD CONSTRAINT "CommissionPlanAssignment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CommissionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionCommission" ADD CONSTRAINT "TransactionCommission_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionCommission" ADD CONSTRAINT "TransactionCommission_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerPrice" ADD CONSTRAINT "ResellerPrice_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResellerPrice" ADD CONSTRAINT "ResellerPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionFlat" ADD CONSTRAINT "CommissionFlat_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionFlat" ADD CONSTRAINT "CommissionFlat_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierHealthLog" ADD CONSTRAINT "SupplierHealthLog_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "SupplierEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
