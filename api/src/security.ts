import bcrypt from "bcryptjs";

export async function verifyDeviceApiKey(apiKey: string, apiKeyHash: string) {
  if (!apiKey) return false;
  return bcrypt.compare(apiKey, apiKeyHash);
}

export async function hashApiKey(apiKey: string) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(apiKey, salt);
}

