-- CreateTable
CREATE TABLE "ResellerDevice" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,

    CONSTRAINT "ResellerDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResellerDevice_resellerId_deviceType_deviceId_key" ON "ResellerDevice"("resellerId", "deviceType", "deviceId");

-- AddForeignKey
ALTER TABLE "ResellerDevice" ADD CONSTRAINT "ResellerDevice_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
