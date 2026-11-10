// Uploaded files → Cloudinary (private), with the local disk as fallback.
//
// Every upload route keeps using multer's disk storage as a TEMP step; right after multer,
// `pushUploadsToCloud(folder)` moves each file to Cloudinary and deletes the temp copy.
// The stored `filename` stays the file's id everywhere (DB records, URLs), so the rest of the
// code does not change. Files are uploaded as type "authenticated": they have no public link
// and are only served through the backend's own download routes (login + permission checks).
//
// Files uploaded before Cloudinary was set up are still on disk; every helper here checks the
// disk first, so they keep working. With no CLOUDINARY_* settings, everything stays on disk.
//
// Meeting recordings (up to 1 GB, transcribed from disk) and voice samples do NOT use this.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { v2 as cloudinary } from "cloudinary";

export const MAX_UPLOAD_MB = 8;
export const MAX_UPLOAD_SIZE = MAX_UPLOAD_MB * 1024 * 1024; // 8 MB per file

const RESOURCE = { resource_type: "raw", type: "authenticated" };
let configured = false;

/** true when Cloudinary credentials are set (CLOUDINARY_URL or the three separate keys) */
export const cloudEnabled = () => {
  const { CLOUDINARY_URL, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  const ok = Boolean(CLOUDINARY_URL || (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET));
  if (ok && !configured) {
    // Always pass the keys explicitly: the SDK reads CLOUDINARY_URL only when it is first
    // imported, which happens before .env is loaded.
    let keys = { cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET };
    if (CLOUDINARY_URL) {
      const url = new URL(CLOUDINARY_URL.trim()); // cloudinary://<api_key>:<api_secret>@<cloud_name>
      keys = {
        cloud_name: url.hostname,
        api_key: decodeURIComponent(url.username),
        api_secret: decodeURIComponent(url.password),
      };
    }
    cloudinary.config({ ...keys, secure: true });
    configured = true;
  }
  return ok;
};

const ROOT = () => (process.env.CLOUDINARY_FOLDER || "task-management").replace(/^\/+|\/+$/g, "");

// raw files keep their extension inside the public id
const publicIdOf = (folder, filename) => `${ROOT()}/${folder}/${path.basename(String(filename))}`;

const localPathOf = (dir, filename) => path.join(dir, path.basename(String(filename)));

/** Upload one local file to Cloudinary, then delete the local copy. */
export const pushFileToCloud = async (localPath, folder, filename = path.basename(localPath)) => {
  await cloudinary.uploader.upload(localPath, {
    ...RESOURCE,
    public_id: publicIdOf(folder, filename),
    overwrite: false,
    use_filename: false,
    unique_filename: false,
  });
  await fs.promises.unlink(localPath).catch(() => {});
};

/**
 * Express middleware — put it right after a multer middleware.
 * Sends req.file / req.files to Cloudinary. If an upload fails the request is stopped
 * (502) and nothing is left behind, so no record ever points at a missing file.
 */
export const pushUploadsToCloud = (folder) => async (req, res, next) => {
  // only files multer saved to disk — in-memory uploads (CSV imports) are read, never stored
  const files = [...(req.files || []), ...(req.file ? [req.file] : [])].filter((f) => f.path);
  if (!files.length || !cloudEnabled()) return next();

  const results = await Promise.allSettled(files.map((f) => pushFileToCloud(f.path, folder, f.filename)));
  const failed = results.find((r) => r.status === "rejected");
  if (!failed) return next();

  console.error("Cloudinary upload failed:", failed.reason?.message || failed.reason);
  await Promise.all(
    files.map(async (f, i) => {
      await fs.promises.unlink(f.path).catch(() => {});
      if (results[i].status === "fulfilled") {
        await cloudinary.uploader.destroy(publicIdOf(folder, f.filename), RESOURCE).catch(() => {});
      }
    })
  );
  return res.status(502).json({ success: false, message: "The file could not be uploaded to storage. Please try again." });
};

/**
 * Send a stored file to the client — disk first (older files), then Cloudinary.
 * inline: show in the browser (images / previews) instead of downloading.
 */
export const sendStoredFile = async (res, { dir, folder, filename, downloadName, mimetype, inline = false }) => {
  const full = localPathOf(dir, filename);
  if (fs.existsSync(full)) {
    if (inline) {
      if (mimetype) res.type(mimetype);
      return res.sendFile(full);
    }
    return res.download(full, downloadName || path.basename(full));
  }

  if (!cloudEnabled()) {
    return res.status(404).json({ success: false, message: "The file is no longer available on the server" });
  }

  // signed URL for the private asset — fetched by the server, never given to the browser
  const url = cloudinary.url(publicIdOf(folder, filename), { ...RESOURCE, sign_url: true, secure: true });
  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) {
    return res.status(404).json({ success: false, message: "The file is no longer available" });
  }

  res.type(mimetype || upstream.headers.get("content-type") || "application/octet-stream");
  const length = upstream.headers.get("content-length");
  if (length) res.set("Content-Length", length);
  if (inline) res.set("Content-Disposition", "inline");
  else res.attachment(downloadName || path.basename(String(filename)));

  Readable.fromWeb(upstream.body)
    .on("error", (err) => {
      console.error("Cloudinary stream error:", err.message);
      res.destroy(err);
    })
    .pipe(res);
};

/** Delete a stored file wherever it is (disk and/or Cloudinary). Never throws. */
export const removeStoredFile = async (dir, folder, filename) => {
  if (!filename) return;
  await fs.promises.unlink(localPathOf(dir, filename)).catch(() => {});
  if (cloudEnabled()) {
    await cloudinary.uploader
      .destroy(publicIdOf(folder, filename), { ...RESOURCE, invalidate: true })
      .catch((err) => console.error("Cloudinary delete failed:", filename, err.message));
  }
};

/** Move a stored file to another folder (chat → chat-backup). Throws if it cannot. */
export const moveStoredFile = async (fromDir, fromFolder, toDir, toFolder, filename) => {
  const from = localPathOf(fromDir, filename);
  if (fs.existsSync(from)) {
    await fs.promises.rename(from, localPathOf(toDir, filename));
    return;
  }
  if (!cloudEnabled()) return;
  await cloudinary.uploader.rename(publicIdOf(fromFolder, filename), publicIdOf(toFolder, filename), {
    ...RESOURCE,
    to_type: "authenticated",
    overwrite: false,
  });
};
