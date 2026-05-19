ALTER TABLE "Measurement"
ADD COLUMN "uptimeSec" INTEGER,
ADD COLUMN "bootCount" INTEGER,
ADD COLUMN "resetReason" TEXT,
ADD COLUMN "so2Status" TEXT,
ADD COLUMN "so2WarmupRemainingSec" INTEGER,
ADD COLUMN "so2BaselineProgress" INTEGER,
ADD COLUMN "so2BaselineTarget" INTEGER;
