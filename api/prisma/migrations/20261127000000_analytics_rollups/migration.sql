-- CreateTable
CREATE TABLE "HourlyAverage" (
    "deviceId" TEXT NOT NULL,
    "hourStart" TIMESTAMPTZ(6) NOT NULL,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "pm25Avg" DOUBLE PRECISION,
    "pm25Max" DOUBLE PRECISION,
    "pm25Minutes" INTEGER NOT NULL DEFAULT 0,
    "pm10Avg" DOUBLE PRECISION,
    "pm10Max" DOUBLE PRECISION,
    "pm10Minutes" INTEGER NOT NULL DEFAULT 0,
    "so2Avg" DOUBLE PRECISION,
    "so2Max" DOUBLE PRECISION,
    "so2Minutes" INTEGER NOT NULL DEFAULT 0,
    "coAvg" DOUBLE PRECISION,
    "coMax" DOUBLE PRECISION,
    "coMinutes" INTEGER NOT NULL DEFAULT 0,
    "no2Avg" DOUBLE PRECISION,
    "no2Max" DOUBLE PRECISION,
    "no2Minutes" INTEGER NOT NULL DEFAULT 0,
    "co2Avg" DOUBLE PRECISION,
    "co2Max" DOUBLE PRECISION,
    "co2Minutes" INTEGER NOT NULL DEFAULT 0,
    "vocAvg" DOUBLE PRECISION,
    "vocMax" DOUBLE PRECISION,
    "vocMinutes" INTEGER NOT NULL DEFAULT 0,
    "nh3Avg" DOUBLE PRECISION,
    "nh3Max" DOUBLE PRECISION,
    "nh3Minutes" INTEGER NOT NULL DEFAULT 0,
    "tempCAvg" DOUBLE PRECISION,
    "rhAvg" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HourlyAverage_pkey" PRIMARY KEY ("deviceId","hourStart")
);

-- CreateTable
CREATE TABLE "DataDeletionLog" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL,
    "deviceId" TEXT,
    "rangeFrom" TIMESTAMPTZ(6),
    "rangeTo" TIMESTAMPTZ(6) NOT NULL,
    "maxCategory" TEXT NOT NULL,
    "deletedCount" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "DataDeletionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HourlyAverage_hourStart_idx" ON "HourlyAverage"("hourStart");

-- CreateIndex
CREATE INDEX "DataDeletionLog_createdAt_idx" ON "DataDeletionLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PollutionEvent_deviceId_pollutant_startedAt_key" ON "PollutionEvent"("deviceId", "pollutant", "startedAt");

-- AddForeignKey
ALTER TABLE "HourlyAverage" ADD CONSTRAINT "HourlyAverage_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Rolling 1h/8h/24h/annual summaries are now computed on request and no longer cached;
-- only "daily" summaries are stored. Remove the old cache rows.
DELETE FROM "AnalyticsSummary" WHERE "period" IN ('1h', '8h', '24h', 'annual');
