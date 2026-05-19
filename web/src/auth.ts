export type AdminSession = {
  email: string;
  signedInAt: string;
};

const adminSessionStorageKey = "aqi:admin-session";

function readSessionStorage() {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}

export function getAdminSession(): AdminSession | null {
  const storage = readSessionStorage();
  if (!storage) return null;

  try {
    const rawSession = storage.getItem(adminSessionStorageKey);
    if (!rawSession) return null;

    const parsed = JSON.parse(rawSession) as Partial<AdminSession>;
    if (typeof parsed.email !== "string" || typeof parsed.signedInAt !== "string") {
      storage.removeItem(adminSessionStorageKey);
      return null;
    }

    return { email: parsed.email, signedInAt: parsed.signedInAt };
  } catch {
    storage.removeItem(adminSessionStorageKey);
    return null;
  }
}

export function isAdminAuthenticated() {
  return getAdminSession() !== null;
}

export function signInAdmin(email: string) {
  const storage = readSessionStorage();
  if (!storage) return;

  storage.setItem(
    adminSessionStorageKey,
    JSON.stringify({
      email: email.trim().toLowerCase(),
      signedInAt: new Date().toISOString()
    } satisfies AdminSession)
  );
}

export function signOutAdmin() {
  const storage = readSessionStorage();
  storage?.removeItem(adminSessionStorageKey);
}
