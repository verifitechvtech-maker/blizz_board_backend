import express from "express";
import PushSubscription from "../models/PushSubscription.js";
import { pushPublicKey } from "../services/pushService.js";

const router = express.Router();

// Public VAPID key the browser needs to subscribe ("" → push not configured)
router.get("/public-key", (req, res) => {
  res.json({ success: true, publicKey: pushPublicKey() });
});

// Save (or move to this user) the browser's subscription
router.post("/subscribe", async (req, res) => {
  const { endpoint, keys } = req.body?.subscription || req.body || {};
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ success: false, message: "Invalid push subscription." });
  }
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      user: req.user._id,
      endpoint,
      keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
      userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json({ success: true });
});

// Remove this browser (logout / turned off)
router.post("/unsubscribe", async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) await PushSubscription.deleteOne({ endpoint, user: req.user._id });
  res.json({ success: true });
});

export default router;
