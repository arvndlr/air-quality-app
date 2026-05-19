import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "../src/prisma.js";
import { hashApiKey } from "../src/security.js";

const args = process.argv.slice(2);

function readFlag(name: string) {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const inputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional()
});

async function main() {
  const parsed = inputSchema.parse({
    id: readFlag("id"),
    name: readFlag("name")
  });

  const apiKey = randomBytes(24).toString("base64url");
  const apiKeyHash = await hashApiKey(apiKey);

  const device = await prisma.device.upsert({
    where: { externalId: parsed.id },
    update: { name: parsed.name ?? undefined, apiKeyHash },
    create: { externalId: parsed.id, name: parsed.name, apiKeyHash }
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ deviceId: device.externalId, apiKey }, null, 2));
}

main().finally(async () => {
  await prisma.$disconnect();
});

