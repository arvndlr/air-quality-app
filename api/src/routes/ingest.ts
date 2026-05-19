import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { verifyDeviceApiKey } from "../security.js";
import type { WsHub } from "../ws-hub.js";
import { asyncHandler } from "../async-handler.js";
import { computeAqi } from "../aqi.js";

export function ingestRouter(hub: WsHub) {
  const router = Router();

  const bodySchema = z.object({
    deviceId: z.string().min(1),
    ts: z.coerce.date().optional(),
    bme: z
      .object({
        tempC: z.number().finite().optional(),
        rh: z.number().finite().optional(),
        hpa: z.number().finite().optional(),
        gasKohm: z.number().finite().optional(),
        vocIndex: z.number().finite().optional()
      })
      .optional(),
    scd40: z
      .object({
        co2ppm: z.number().int().optional(),
        tempC: z.number().finite().optional(),
        rh: z.number().finite().optional()
      })
      .optional(),
    battery: z
      .object({
        voltage: z.number().finite().optional(),
        chargerOn: z.boolean().optional()
      })
      .optional(),
    system: z
      .object({
        uptimeSec: z.number().int().nonnegative().optional(),
        bootCount: z.number().int().nonnegative().optional(),
        resetReason: z.string().min(1).optional(),
        so2Status: z.enum(["warming", "calibrating", "ok"]).optional(),
        so2WarmupRemainingSec: z.number().int().nonnegative().optional(),
        so2BaselineProgress: z.number().int().nonnegative().optional(),
        so2BaselineTarget: z.number().int().positive().optional()
      })
      .optional(),
    pm: z
      .object({
        pm1ugm3: z.number().finite().optional(),
        pm25ugm3: z.number().finite().optional(),
        pm10ugm3: z.number().finite().optional()
      })
      .optional(),
    so2: z
      .object({
        vgas: z.number().finite().optional(),
        vref: z.number().finite().optional(),
        mv: z.number().finite().optional(),
        ppb: z.number().finite().optional()
      })
      .optional(),
    mics6814: z
      .object({
        nh3V: z.number().finite().optional(),
        coV: z.number().finite().optional(),
        no2V: z.number().finite().optional(),
        coPpm: z.number().finite().optional(),
        no2Ppb: z.number().finite().optional(),
        nh3Ppm: z.number().finite().optional()
      })
      .optional()
  });

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const apiKey = req.header("x-api-key") ?? "";
      const payload = bodySchema.parse(req.body);

      const device = await prisma.device.findUnique({ where: { externalId: payload.deviceId } });
      if (!device) return res.status(404).json({ error: "Device not found" });

      const ok = await verifyDeviceApiKey(apiKey, device.apiKeyHash);
      if (!ok) return res.status(401).json({ error: "Invalid API key" });

      const ts = payload.ts ?? new Date();

      const data: Prisma.MeasurementUncheckedCreateInput = {
        deviceId: device.id,
        ts,
        tempC: payload.bme?.tempC,
        rh: payload.bme?.rh,
        pressureHpa: payload.bme?.hpa,
        gasKohm: payload.bme?.gasKohm,
        vocIndex: payload.bme?.vocIndex,
        batteryVoltage: payload.battery?.voltage,
        chargerOn: payload.battery?.chargerOn,
        uptimeSec: payload.system?.uptimeSec,
        bootCount: payload.system?.bootCount,
        resetReason: payload.system?.resetReason,
        so2Status: payload.system?.so2Status,
        so2WarmupRemainingSec: payload.system?.so2WarmupRemainingSec,
        so2BaselineProgress: payload.system?.so2BaselineProgress,
        so2BaselineTarget: payload.system?.so2BaselineTarget,
        co2ppm: payload.scd40?.co2ppm,
        scdTempC: payload.scd40?.tempC,
        scdRh: payload.scd40?.rh,
        pm1ugm3: payload.pm?.pm1ugm3,
        pm25ugm3: payload.pm?.pm25ugm3,
        pm10ugm3: payload.pm?.pm10ugm3,
        so2Vgas: payload.so2?.vgas,
        so2Vref: payload.so2?.vref,
        so2Mv:
          payload.so2?.mv ??
          (payload.so2?.vgas != null && payload.so2?.vref != null ? (payload.so2.vgas - payload.so2.vref) * 1000 : null),
        micsNh3V: payload.mics6814?.nh3V,
        micsCoV: payload.mics6814?.coV,
        micsNo2V: payload.mics6814?.no2V,
        so2Ppb: payload.so2?.ppb,
        micsCoPpm: payload.mics6814?.coPpm,
        micsNo2Ppb: payload.mics6814?.no2Ppb,
        micsNh3Ppm: payload.mics6814?.nh3Ppm
      };

      const created = await prisma.measurement.create({ data });

      const aqi = computeAqi({
        pm25: created.pm25ugm3,
        pm10: created.pm10ugm3,
        co: created.micsCoPpm,
        no2: created.micsNo2Ppb,
        so2: created.so2Ppb
      });

      hub.publish(device.externalId, {
        type: "measurement",
        deviceId: device.externalId,
        measurement: created,
        aqi
      });

      res.status(201).json({ ok: true });
    })
  );

  return router;
}
