-- CreateTable
CREATE TABLE "ResellerGlobalMarkup" (
    "resellerId" TEXT NOT NULL,
    "markup" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ResellerGlobalMarkup_pkey" PRIMARY KEY ("resellerId")
);

-- AddForeignKey
ALTER TABLE "ResellerGlobalMarkup" ADD CONSTRAINT "ResellerGlobalMarkup_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "Reseller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
