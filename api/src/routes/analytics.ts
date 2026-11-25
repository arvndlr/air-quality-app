
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { verifyDeviceApiKey } from "../security.js";
import { asyncHandler } from "../async-handler.js";
import { calculateAnalytics } from "../analytics-engine.js";

export const analyticsRouter = Router();

analyticsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const query = z.object({
      deviceId: z.string().min(1),
      period: z.enum(["1h", "8h", "24h", "annual"])
    }).parse(req.query);

    // Find registered device
    const device = await prisma.device.findUnique({
      where: { externalId: query.deviceId }
    });

    if (!device) {
      return res.status(404).json({
        error: "Device not found"
      });
    }

    // Validate device API key
    const apiKey = req.header("x-api-key") ?? "";

    const validKey = await verifyDeviceApiKey(
      apiKey,
      device.apiKeyHash
    );

    if (!validKey) {
      return res.status(401).json({
        error: "Invalid API key"
      });
    }

    // Calculate analytics
    const result = await calculateAnalytics(
      query.deviceId,
      query.period
    );

    return res.json(result);
  })
);
