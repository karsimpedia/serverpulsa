/*
  Warnings:

  - A unique constraint covering the columns `[deviceId]` on the table `ResellerDevice` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ResellerDevice_deviceId_key" ON "ResellerDevice"("deviceId");
