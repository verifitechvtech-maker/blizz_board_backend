import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ChatFileBackup from "../models/ChatFileBackup.js";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import Department from "../models/Department.js";
import User from "../models/User.js";
import { moveStoredFile, sendStoredFile, removeStoredFile } from "./fileStorage.js";

const UPLOADS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../uploads");
export const CHAT_DIR = path.join(UPLOADS, "chat");
export const CHAT_BACKUP_DIR = path.join(UPLOADS, "chat-backup");
fs.mkdirSync(CHAT_BACKUP_DIR, { recursive: true });

const CHAT_FOLDER = "chat";
const BACKUP_FOLDER = "chat-backup";
const whereIs = (record) =>
  record.location === "backup" ? { dir: CHAT_BACKUP_DIR, folder: BACKUP_FOLDER } : { dir: CHAT_DIR, folder: CHAT_FOLDER };

/** Download a backed-up chat file (disk or Cloudinary) */
export const sendBackupFile = (res, record) =>
  sendStoredFile(res, { ...whereIs(record), filename: record.filename, downloadName: record.name, mimetype: record.mimetype });

/** Permanently delete a backed-up chat file (disk or Cloudinary) */
export const removeBackupFile = (record) => {
  const { dir, folder } = whereIs(record);
  return removeStoredFile(dir, folder, record.filename);
};

export const backupFilePath = (record) =>
  path.join(record.location === "backup" ? CHAT_BACKUP_DIR : CHAT_DIR, path.basename(record.filename));

const conversationLabel = async (conversation) => {
  if (!conversation) return "";
  if (conversation.type === "group") return conversation.name || "Group";
  if (conversation.type === "department") {
    const dept = await Department.findById(conversation.department).select("name").lean();
    return dept?.name ? `${dept.name} (department)` : "Department";
  }
  const people = await User.find({ _id: { $in: conversation.participants || [] } }).select("name").lean();
  return people.map((p) => p.name).join(" & ") || "Private chat";
};

/** Record the files of a just-sent message. visibleTo = sender + recipients. */
export const recordChatFiles = async (message, conversation, { senderName = "", visibleTo = [] } = {}) => {
  if (!message?.attachments?.length) return;
  const conversationName = await conversationLabel(conversation);
  const viewers = [...new Set([String(message.sender), ...visibleTo.map(String)])];

  await ChatFileBackup.bulkWrite(
    message.attachments.map((a) => ({
      updateOne: {
        filter: { filename: a.filename },
        update: {
          $setOnInsert: {
            admin_id: conversation.admin_id,
            conversation: conversation._id,
            conversationType: conversation.type,
            conversationName,
            message: message._id,
            sender: message.sender,
            senderName,
            visibleTo: viewers,
            filename: a.filename,
            name: a.name,
            size: a.size,
            mimetype: a.mimetype,
            sharedAt: message.createdAt || new Date(),
          },
        },
        upsert: true,
      },
    }))
  );
};

/** Messages about to be deleted → move their files into the backup folder (never delete them). */
export const backupFilesOf = async (messages) => {
  for (const m of messages) {
    if (!m.attachments?.length) continue;
    const conversation = await Conversation.findById(m.conversation).lean();
    if (conversation) {
      const sender = await User.findById(m.sender).select("name").lean();
      const viewers = conversation.type === "department" ? [] : conversation.participants || [];
      await recordChatFiles(m, conversation, { senderName: sender?.name || "", visibleTo: viewers });
    }

    for (const a of m.attachments) {
      const file = path.basename(a.filename);
      try {
        await moveStoredFile(CHAT_DIR, CHAT_FOLDER, CHAT_BACKUP_DIR, BACKUP_FOLDER, file);
      } catch (err) {
        console.error("chat backup: could not move", file, err.message);
        continue; // leave the record pointing at the chat folder
      }
      await ChatFileBackup.updateOne(
        { filename: a.filename },
        { location: "backup", messageDeletedAt: new Date(), message: null }
      );
    }
  }
};

/** One-time: files shared before the backup existed get their records. */
export const backfillChatFileBackups = async () => {
  const known = new Set((await ChatFileBackup.find().select("filename").lean()).map((r) => r.filename));
  const messages = await Message.find({ "attachments.0": { $exists: true } }).lean();
  let added = 0;
  for (const m of messages) {
    if (m.attachments.every((a) => known.has(a.filename))) continue;
    const conversation = await Conversation.findById(m.conversation).lean();
    if (!conversation) continue;
    const sender = await User.findById(m.sender).select("name").lean();
    const viewers = conversation.type === "department" ? [] : conversation.participants || [];
    await recordChatFiles(m, conversation, { senderName: sender?.name || "", visibleTo: viewers });
    added += m.attachments.length;
  }
  return added;
};
