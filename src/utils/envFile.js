// Update one KEY=value line in backend/.env (keeps a backup in .env.backup).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");

export const setEnvValue = (key, value, envPath = ENV_PATH) => {
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  if (current) fs.writeFileSync(`${envPath}.backup`, current, { mode: 0o600 });
  const line = `${key}=${value}`;
  const rx = new RegExp(`^${key}=.*$`, "m");
  const next = rx.test(current) ? current.replace(rx, line) : `${current.replace(/\s*$/, "")}\n${line}\n`;
  fs.writeFileSync(envPath, next, { mode: 0o600 });
};
