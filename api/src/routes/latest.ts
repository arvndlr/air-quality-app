
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

    const device = await prisma.device.findUnique({
      where: { externalId: deviceId }
    });

    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    const measurement = await prisma.measurement.findFirst({
      where: { deviceId: device.id },
      orderBy: { ts: "desc" }
    });

    if (!measurement) {
      return res.json({
        deviceId,
        latest: null,
        aqi: null
      });
    }

    // Database and AQI use PPB.
    // Website receives PPM.
    const latest = {
      ...measurement,
      so2Ppm:
        measurement.so2Ppb != null
          ? measurement.so2Ppb / 1000
          : null
    };

    const aqi = computeAqi({
      pm25: measurement.pm25ugm3,
      pm10: measurement.pm10ugm3,
      co: measurement.micsCoPpm,
      no2: measurement.micsNo2Ppb,
      so2: measurement.so2Ppb
    });

    res.json({
      deviceId,
      latest,
      aqi
    });
  })
);
