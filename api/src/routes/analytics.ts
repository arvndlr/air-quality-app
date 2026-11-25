
import { Router } from "express";
import { z } from "zod";
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

    const result = await calculateAnalytics(
      query.deviceId,
      query.period
    );

    res.json(result);
  })
);
