import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";

export interface TrustedRemoteDevice {
  deviceId: string;
  name: string;
  publicKeyPem: string;
  addedAt: number;
  lastSeenAt?: number;
}
export interface HostIdentity {
  hostId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  hmacSecret: string;
  trustedDevices: TrustedRemoteDevice[];
}

function hostIdFor(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 24);
}

export function fingerprintFor(publicKeyPem: string): string {
  return `sha256-${createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 32)}`;
}

function createIdentity(): HostIdentity {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    hostId: hostIdFor(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    hmacSecret: randomBytes(32).toString("base64url"),
    trustedDevices: [],
  };
}

function protect(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(value).toString("base64")}`;
  } catch {
    /* Electron safeStorage may not be ready in a test shell; use the fallback. */
  }
  return value;
}

function unprotect(value: string): string {
  if (!value.startsWith("enc:")) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
  } catch {
    return "";
  }
}

function persistedIdentity(identity: HostIdentity): Record<string, unknown> {
  return {
    ...identity,
    privateKeyPem: protect(identity.privateKeyPem),
    hmacSecret: protect(identity.hmacSecret),
  };
}

export function loadOrCreateIdentity(dir: string): HostIdentity {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "remote-identity.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as HostIdentity;
      const privateKeyPem = typeof parsed.privateKeyPem === "string" ? unprotect(parsed.privateKeyPem) : "";
      const hmacSecret = typeof parsed.hmacSecret === "string" ? unprotect(parsed.hmacSecret) : "";
      if (parsed.hostId && parsed.publicKeyPem && privateKeyPem && hmacSecret) {
        return { ...parsed, privateKeyPem, hmacSecret, trustedDevices: Array.isArray(parsed.trustedDevices) ? parsed.trustedDevices : [] };
      }
    } catch {
      /* recreate a corrupt identity */
    }
  }
  const identity = createIdentity();
  writeFileSync(file, JSON.stringify(persistedIdentity(identity), null, 2), "utf8");
  return identity;
}

export function saveIdentity(dir: string, identity: HostIdentity): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "remote-identity.json"), JSON.stringify(persistedIdentity(identity), null, 2), "utf8");
}

export function opaqueId(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url").slice(0, 24);
}

export function signText(privateKeyPem: string, text: string): string {
  return sign(null, Buffer.from(text, "utf8"), createPrivateKey(privateKeyPem)).toString("base64url");
}

export function verifyText(publicKeyPem: string, text: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(text, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function deviceIdFor(publicKeyPem: string): string {
  return `device-${createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 24)}`;
}
