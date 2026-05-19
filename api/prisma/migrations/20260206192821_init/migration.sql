-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "apiKeyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Measurement" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "tempC" DOUBLE PRECISION,
    "rh" DOUBLE PRECISION,
    "pressureHpa" DOUBLE PRECISION,
    "gasKohm" DOUBLE PRECISION,
    "co2ppm" INTEGER,
    "scdTempC" DOUBLE PRECISION,
    "scdRh" DOUBLE PRECISION,

    CONSTRAINT "Measurement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_externalId_key" ON "Device"("externalId");

-- CreateIndex
CREATE INDEX "Device_externalId_idx" ON "Device"("externalId");

-- CreateIndex
CREATE INDEX "Measurement_deviceId_ts_idx" ON "Measurement"("deviceId", "ts" DESC);

-- CreateIndex
CREATE INDEX "Measurement_ts_idx" ON "Measurement"("ts" DESC);

-- AddForeignKey
ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
