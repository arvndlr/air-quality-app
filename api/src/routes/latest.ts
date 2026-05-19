import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../async-handler.js";
import { computeAqi } from "../aqi.js";

export const latestRouter = Router();

latestRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const querySchema = z.object({ deviceId: z.string().min(1) });
    const { deviceId } = querySchema.parse(req.query);

    const device = await prisma.device.findUnique({ where: { externalId: deviceId } });
    if (!device) return res.status(404).json({ error: "Device not found" });

    const latest = await prisma.measurement.findFirst({
      where: { deviceId: device.id },
      orderBy: { ts: "desc" }
    });

    const aqi = latest
      ? computeAqi({
          pm25: latest.pm25ugm3,
          pm10: latest.pm10ugm3,
          co: latest.micsCoPpm,
          no2: latest.micsNo2Ppb,
          so2: latest.so2Ppb
        })
      : null;

    res.json({ deviceId, latest, aqi });
  })
);
