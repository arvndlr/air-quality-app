import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../async-handler.js";
import { calculateAnalytics } from "../analytics-engine.js";

export const analyticsRouter = Router();

// Public, like the other read endpoints. Only /ingest requires a device API key.
analyticsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        deviceId: z.string().min(1),
        period: z.enum(["1h", "8h", "24h", "annual"])
      })
      .parse(req.query);

    const device = await prisma.device.findUnique({
      where: { externalId: query.deviceId }
    });

    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    const result = await calculateAnalytics(device, query.period);
    return res.json(result);
  })
);
