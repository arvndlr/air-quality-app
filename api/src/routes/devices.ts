import { Router } from "express";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../async-handler.js";

export const devicesRouter = Router();

devicesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
  const devices = await prisma.device.findMany({
    orderBy: { createdAt: "asc" },
    select: { externalId: true, name: true, createdAt: true }
  });
  res.json({ devices });
  })
);
