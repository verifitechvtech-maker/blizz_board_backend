import mongoose from "mongoose";
import Notification from "../models/Notification.js";

// GET /api/notifications?unread=true&limit=20  — only MY notifications
export const getMyNotifications = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const filter = { recipient: req.user._id };
    if (req.query.unread === "true") filter.read = false;
    if (req.query.type) filter.type = String(req.query.type);

    const [items, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ recipient: req.user._id, read: false }),
    ]);
    res.json({ success: true, unread, count: items.length, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/notifications/:id/read
export const markNotificationRead = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid notification ID" });
    }
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id },
      { read: true },
      { new: true }
    );
    if (!n) return res.status(404).json({ success: false, message: "Notification not found" });
    res.json({ success: true, data: n });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/notifications/read-all
export const markAllNotificationsRead = async (req, res) => {
  try {
    const r = await Notification.updateMany({ recipient: req.user._id, read: false }, { read: true });
    res.json({ success: true, updated: r.modifiedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
