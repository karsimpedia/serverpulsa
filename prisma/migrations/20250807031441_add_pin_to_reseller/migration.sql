/*
  Warnings:

  - Added the required column `pin` to the `Reseller` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Reseller" ADD COLUMN     "address" TEXT,
ADD COLUMN     "pin" TEXT NOT NULL;
