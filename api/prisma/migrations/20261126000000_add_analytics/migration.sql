-- CreateTable
CREATE TABLE "AnalyticsSummary" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "windowEnd" TIMESTAMPTZ(6) NOT NULL,
    "computedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "coveragePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isValid" BOOLEAN NOT NULL DEFAULT false,
    "avgPm25" DOUBLE PRECISION,
    "avgPm10" DOUBLE PRECISION,
    "avgCO" DOUBLE PRECISION,
    "avgCO2" DOUBLE PRECISION,
    "avgNO2" DOUBLE PRECISION,
    "avgSO2" DOUBLE PRECISION,
    "aqi" INTEGER,
    "category" TEXT,
    "dominantPollutant" TEXT,
    "pollutantDetails" JSONB,

    CONSTRAINT "AnalyticsSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollutionEvent" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "pollutant" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "endedAt" TIMESTAMPTZ(6),
    "peakValue" DOUBLE PRECISION,
    "averageValue" DOUBLE PRECISION,
    "thresholdValue" DOUBLE PRECISION,
    "unit" TEXT,
    "consecutiveDays" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "possibleCauses" JSONB,
    "healthEffects" JSONB,
    "affectedGroups" JSONB,
    "recommendations" JSONB,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PollutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsRun" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "windowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "eventsDetected" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "AnalyticsRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsSummary_deviceId_period_windowEnd_idx" ON "AnalyticsSummary"("deviceId", "period", "windowEnd");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSummary_deviceId_period_windowStart_key" ON "AnalyticsSummary"("deviceId", "period", "windowStart");

-- CreateIndex
CREATE INDEX "PollutionEvent_deviceId_startedAt_idx" ON "PollutionEvent"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "PollutionEvent_deviceId_pollutant_status_idx" ON "PollutionEvent"("deviceId", "pollutant", "status");

-- CreateIndex
CREATE INDEX "PollutionEvent_severity_startedAt_idx" ON "PollutionEvent"("severity", "startedAt");

-- CreateIndex
CREATE INDEX "AnalyticsRun_deviceId_startedAt_idx" ON "AnalyticsRun"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "AnalyticsRun_status_idx" ON "AnalyticsRun"("status");

-- AddForeignKey
ALTER TABLE "AnalyticsSummary" ADD CONSTRAINT "AnalyticsSummary_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollutionEvent" ADD CONSTRAINT "PollutionEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsRun" ADD CONSTRAINT "AnalyticsRun_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

