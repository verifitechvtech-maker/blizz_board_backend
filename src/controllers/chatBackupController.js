// Settings → Chat file backup: every file shared in chat, including files whose
// disappearing message was deleted (those live in uploads/chat-backup).
import mongoose from "mongoose";
import ChatFileBackup from "../models/ChatFileBackup.js";
import { sendBackupFile, removeBackupFile } from "../services/chatBackupService.js";

const isOrgAdmin = (req) => ["SuperAdmin", "Admin"].includes(req.user.role);
const orgIdOf = (req) => (req.user.role === "Admin" ? req.user._id : req.adminId);
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// SuperAdmin → everything · Admin → their organization · others → files they sent or received
const scope = (req) => {
  if (req.user.role === "SuperAdmin") return {};
  if (req.user.role === "Admin") return { admin_id: orgIdOf(req) };
  return { visibleTo: req.user._id };
};

// GET /api/chat/backup?search=&location=all|chat|backup&page=1&limit=50
export const listChatBackup = async (req, res) => {
  try {
    const filter = { ...scope(req) };
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: rx }, { senderName: rx }, { conversationName: rx }];
    }
    if (["chat", "backup"].includes(req.query.location)) filter.location = req.query.location;

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const [items, total, totals] = await Promise.all([
      ChatFileBackup.find(filter)
        .select("-visibleTo")
        .sort({ sharedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ChatFileBackup.countDocuments(filter),
      ChatFileBackup.aggregate([
        { $match: scope(req) },
        { $group: { _id: "$location", count: { $sum: 1 }, size: { $sum: "$size" } } },
      ]),
    ]);

    const summary = { files: 0, size: 0, inChat: 0, backedUp: 0 };
    totals.forEach((t) => {
      summary.files += t.count;
      summary.size += t.size;
      if (t._id === "backup") summary.backedUp = t.count;
      else summary.inChat = t.count;
    });

    res.json({ success: true, total, page, limit, summary, canDelete: isOrgAdmin(req), data: items });
  } catch (err) {
    console.error("listChatBackup:", err);
    res.status(500).json({ success: false, message: "Unable to load the chat file backup." });
  }
};

const findRecord = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid file ID" });
    return null;
  }
  const record = await ChatFileBackup.findOne({ _id: req.params.id, ...scope(req) }).lean();
  if (!record) res.status(404).json({ success: false, message: "File not found" });
  return record;
};

// GET /api/chat/backup/:id/download
export const downloadChatBackup = async (req, res) => {
  try {
    const record = await findRecord(req, res);
    if (!record) return;
    res.set("Cache-Control", "private, no-store");
    return sendBackupFile(res, record);
  } catch (err) {
    console.error("downloadChatBackup:", err);
    res.status(500).json({ success: false, message: "Unable to download the file." });
  }
};

// DELETE /api/chat/backup/:id — Admin / SuperAdmin; only files whose message is already gone
export const deleteChatBackup = async (req, res) => {
  try {
    if (!isOrgAdmin(req)) {
      return res.status(403).json({ success: false, message: "Only administrators can delete backed-up files" });
    }
    const record = await findRecord(req, res);
    if (!record) return;
    if (record.location !== "backup") {
      return res.status(409).json({
        success: false,
        message: "This file is still in a chat message. It can be removed from the backup once that message is gone.",
      });
    }
    await removeBackupFile(record);
    await ChatFileBackup.deleteOne({ _id: record._id });
    res.json({ success: true, message: "File deleted from the backup" });
  } catch (err) {
    console.error("deleteChatBackup:", err);
    res.status(500).json({ success: false, message: "Unable to delete the file." });
  }
};
