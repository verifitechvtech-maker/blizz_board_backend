// Short-lived, reversible storage for an admin-set password until the user
// verifies their email and views it once. AES-256-GCM; key from CREDENTIAL_SECRET
// (falls back to a key derived from JWT_SECRET). Never store plain text.
import crypto from "crypto";

const key = () =>
  crypto
    .createHash("sha256")
    .update(process.env.CREDENTIAL_SECRET || `${process.env.JWT_SECRET}:credential-reveal`)
    .digest();

export const encryptSecret = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
};

export const decryptSecret = (payload) => {
  const [iv, tag, data] = String(payload).split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};

export const newToken = () => crypto.randomBytes(32).toString("hex");
export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
