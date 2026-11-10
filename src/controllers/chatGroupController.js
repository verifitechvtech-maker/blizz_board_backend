// Chat groups (create / rename / add & remove members / leave) and chat attachments.
import mongoose from "mongoose";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import User from "../models/User.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import { emitToUser } from "../socket/realtime.js";
import { MAX_UPLOAD_SIZE, MAX_UPLOAD_MB, pushUploadsToCloud, sendStoredFile, removeStoredFile } from "../services/fileStorage.js";

export const CHAT_UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../uploads/chat");
fs.mkdirSync(CHAT_UPLOAD_DIR, { recursive: true });

export const CHAT_ALLOWED_EXT = ["jpg", "jpeg", "png", "gif", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip", "mp3", "mp4"];
export const CHAT_MAX_FILE = MAX_UPLOAD_SIZE; // 8 MB per file (Cloudinary); message text is not limited
export const CHAT_FILES_FOLDER = "chat"; // Cloudinary folder
const MAX_FILES = 5;
const MAX_GROUP_MEMBERS = 200;

const orgIdOf = (req) => (req.user.role === "Admin" ? req.user._id : req.adminId);
const sameId = (a, b) => Boolean(a && b) && String(a) === String(b);

// Accounts of my organization (Admin + members) with these ids
const orgUsers = async (req, ids) => {
  const orgId = orgIdOf(req);
  const clean = [...new Set((ids || []).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!clean.length) return [];
  const filter = { _id: { $in: clean }, status: "Active" };
  if (req.user.role !== "SuperAdmin") {
    filter.$or = [{ _id: orgId }, { admin_id: orgId }, { createdBy: orgId, admin_id: null }];
  }
  return User.find(filter).select("_id name").lean();
};

const populateGroup = (id) =>
  Conversation.findById(id).populate("participants", "name email department role status").lean();

const notifyMembers = (conversation, event = "chat:conversation:update") =>
  (conversation.participants || []).forEach((p) =>
    emitToUser(p._id || p, event, { conversationId: String(conversation._id), conversation })
  );

const systemNote = async (conversation, sender, text) => {
  const m = await Message.create({ conversation: conversation._id, sender, text, readBy: [sender] });
  await Conversation.updateOne({ _id: conversation._id }, { lastMessage: m._id, lastMessageAt: m.createdAt });
};

// Group managers: group admins (creator), or the organization's Admin / SuperAdmin
const canManage = (req, group) =>
  req.user.role === "SuperAdmin" ||
  sameId(req.user._id, group.admin_id) ||
  (group.groupAdmins || []).some((a) => sameId(a, req.user._id));

const findMyGroup = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid group ID" });
    return null;
  }
  const group = await Conversation.findOne({ _id: req.params.id, type: "group", participants: req.user._id });
  if (!group) res.status(404).json({ success: false, message: "Group not found" });
  return group;
};

// POST /api/chat/groups { name, memberIds: [] }
export const createGroup = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Group name is required." });
    if (name.length > 80) return res.status(400).json({ success: false, message: "Group name is too long (max 80)." });

    const orgId = orgIdOf(req);
    if (!orgId) return res.status(403).json({ success: false, message: "Organization could not be identified." });

    const requested = (req.body?.memberIds || []).filter((id) => !sameId(id, req.user._id));
    const members = await orgUsers(req, requested);
    if (!members.length) {
      return res.status(400).json({ success: false, message: "Select at least one member from your organization." });
    }
    if (members.length + 1 > MAX_GROUP_MEMBERS) {
      return res.status(400).json({ success: false, message: `A group can have at most ${MAX_GROUP_MEMBERS} members.` });
    }

    const group = await Conversation.create({
      type: "group",
      name,
      admin_id: orgId,
      participants: [req.user._id, ...members.map((m) => m._id)],
      groupAdmins: [req.user._id],
      createdBy: req.user._id,
    });
    await systemNote(group, req.user._id, `${req.user.name} created the group "${name}"`);
    const full = await populateGroup(group._id);
    notifyMembers(full);
    res.status(201).json({ success: true, message: `Group "${name}" created`, conversation: full });
  } catch (err) {
    console.error("createGroup:", err);
    res.status(500).json({ success: false, message: "Unable to create the group." });
  }
};

// PATCH /api/chat/groups/:id { name?, addMemberIds?, removeMemberIds? }
export const updateGroup = async (req, res) => {
  try {
    const group = await findMyGroup(req, res);
    if (!group) return;
    if (!canManage(req, group)) {
      return res.status(403).json({ success: false, message: "Only group admins can change this group." });
    }

    const notes = [];
    const removedIds = [];
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ success: false, message: "Group name cannot be empty." });
      if (name !== group.name) notes.push(`renamed the group to "${name}"`);
      group.name = name.slice(0, 80);
    }

    const toAdd = await orgUsers(req, req.body.addMemberIds);
    const fresh = toAdd.filter((u) => !group.participants.some((p) => sameId(p, u._id)));
    if (group.participants.length + fresh.length > MAX_GROUP_MEMBERS) {
      return res.status(400).json({ success: false, message: `A group can have at most ${MAX_GROUP_MEMBERS} members.` });
    }
    group.participants.push(...fresh.map((u) => u._id));
    if (fresh.length) notes.push(`added ${fresh.map((u) => u.name).join(", ")}`);

    const removeIds = (req.body.removeMemberIds || []).map(String).filter((id) => !sameId(id, req.user._id));
    if (removeIds.length) {
      const before = group.participants.map(String);
      group.participants = group.participants.filter((p) => !removeIds.includes(String(p)));
      group.groupAdmins = (group.groupAdmins || []).filter((a) => !removeIds.includes(String(a)));
      const gone = before.filter((id) => !group.participants.map(String).includes(id));
      removedIds.push(...gone);
      if (gone.length) {
        const names = await User.find({ _id: { $in: gone } }).select("name").lean();
        notes.push(`removed ${names.map((u) => u.name).join(", ")}`);
      }
    }

    await group.save();
    for (const note of notes) await systemNote(group, req.user._id, `${req.user.name} ${note}`);
    const full = await populateGroup(group._id);
    notifyMembers(full);
    removedIds.forEach((id) => emitToUser(id, "chat:conversation:removed", { conversationId: String(group._id) }));
    res.json({ success: true, message: "Group updated", conversation: full });
  } catch (err) {
    console.error("updateGroup:", err);
    res.status(500).json({ success: false, message: "Unable to update the group." });
  }
};

// POST /api/chat/groups/:id/leave
export const leaveGroup = async (req, res) => {
  try {
    const group = await findMyGroup(req, res);
    if (!group) return;
    group.participants = group.participants.filter((p) => !sameId(p, req.user._id));
    group.groupAdmins = (group.groupAdmins || []).filter((a) => !sameId(a, req.user._id));
    // Keep the group manageable: promote the longest-standing member
    if (!group.groupAdmins.length && group.participants.length) group.groupAdmins = [group.participants[0]];
    await group.save();
    if (group.participants.length) {
      await systemNote(group, req.user._id, `${req.user.name} left the group`);
      notifyMembers(await populateGroup(group._id));
    }
    res.json({ success: true, message: `You left "${group.name}"` });
  } catch (err) {
    console.error("leaveGroup:", err);
    res.status(500).json({ success: false, message: "Unable to leave the group." });
  }
};

// ==================== ATTACHMENTS ====================
const chatMulter = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CHAT_UPLOAD_DIR),
    filename: (req, file, cb) =>
      cb(null, `chat-${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: CHAT_MAX_FILE, files: MAX_FILES, fieldSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    if (CHAT_ALLOWED_EXT.includes(ext)) return cb(null, true);
    const e = new Error(`"${file.originalname}" is not an allowed file type`);
    e.status = 400;
    cb(e);
  },
}).array("files", MAX_FILES);

const removeFiles = (files = []) =>
  Promise.all(files.map((f) => removeStoredFile(CHAT_UPLOAD_DIR, CHAT_FILES_FOLDER, f.filename)));
const chatToCloud = pushUploadsToCloud(CHAT_FILES_FOLDER);

// Multipart only when files are sent; files of a rejected message are deleted again
export const chatUpload = (req, res, next) => {
  if (!req.is("multipart/form-data")) return next();
  chatMulter(req, res, async (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE" ? `Each file must be ${MAX_UPLOAD_MB} MB or smaller`
        : err.code === "LIMIT_FILE_COUNT" ? `Attach at most ${MAX_FILES} files per message`
        : err.message;
      return res.status(400).json({ success: false, message });
    }
    const empty = (req.files || []).find((f) => f.size === 0);
    if (empty) {
      await removeFiles(req.files);
      return res.status(400).json({ success: false, message: `"${empty.originalname}" is empty` });
    }
    res.on("finish", () => {
      if (res.statusCode >= 400) removeFiles(req.files);
    });
    chatToCloud(req, res, next);
  });
};

// GET /api/chat/attachments/:filename — only for members of that conversation
export const downloadChatAttachment = async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ""));
    const message = await Message.findOne({ "attachments.filename": filename }).select("conversation attachments").lean();
    if (!message) return res.status(404).json({ success: false, message: "Attachment not found" });

    const conversation = await Conversation.findById(message.conversation).lean();
    const orgId = orgIdOf(req);
    let allowed = false;
    if (conversation) {
      if (conversation.type === "department") {
        allowed = req.user.role === "SuperAdmin" || sameId(conversation.admin_id, orgId);
      } else {
        allowed = (conversation.participants || []).some((p) => sameId(p, req.user._id));
      }
    }
    if (!allowed) return res.status(404).json({ success: false, message: "Attachment not found" });

    const file = message.attachments.find((a) => a.filename === filename);
    res.set("Cache-Control", "private, no-store");
    return sendStoredFile(res, {
      dir: CHAT_UPLOAD_DIR,
      folder: CHAT_FILES_FOLDER,
      filename,
      downloadName: file.name,
      mimetype: file.mimetype,
      inline: req.query.inline === "1" && /^image\//.test(file.mimetype),
    });
  } catch (err) {
    console.error("downloadChatAttachment:", err);
    res.status(500).json({ success: false, message: "Unable to download the file." });
  }
};
