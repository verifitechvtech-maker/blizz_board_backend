import webpush from "web-push";
import PushSubscription from "../models/PushSubscription.js";
import User from "../models/User.js";

/* =========================================================
   Web Push — browser notifications that arrive even when
   the app tab (or the whole browser window) is closed.
   Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT in .env
   Without keys push is simply off; nothing else breaks.
========================================================= */

let configured = null;
let sender = (subscription, body, options) => webpush.sendNotification(subscription, body, options);

// Tests swap in a fake so nothing is sent to real push services
export const setPushSender = (fn) => {
  sender = fn;
};

const configure = () => {
  if (configured !== null) return configured;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  configured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
  if (configured) {
    webpush.setVapidDetails(VAPID_SUBJECT || "mailto:admin@localhost", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  }
  return configured;
};

export const pushPublicKey = () => (configure() ? process.env.VAPID_PUBLIC_KEY : "");

const TITLES = {
  task_assigned: "New task assigned",
  task_reassigned: "Task reassigned",
  task_reminder: "Task reminder",
  task_overdue: "Task overdue",
  task_status: "Task status changed",
  task_completed: "🏆 Task completed",
  task_rework: "Task sent back for rework",
  task_comment: "New comment on your task",
  task_subtask: "New subtask",
  support_ticket: "New support ticket",
  support_reply: "Support reply",
};

// Same targets as the bell panel (components/NotificationBell.jsx → linkFor)
const urlFor = (type, role) => {
  if (type === "support_ticket") return role === "SuperAdmin" ? "/superadmin/dashboard" : "/dashboard/support";
  if (type === "support_reply") return "/dashboard/support";
  return "/dashboard/tasks";
};

// Sends one payload to every browser of these users; dead subscriptions are removed
export const sendPushToUsers = async (userIds, payload) => {
  if (!configure()) return 0;
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return 0;

  // Settings → "Desktop notifications" off → no push for that user
  const muted = await User.find({ _id: { $in: ids }, "preferences.desktopNotifications": false }).distinct("_id");
  const mutedSet = new Set(muted.map(String));
  const subs = await PushSubscription.find({ user: { $in: ids.filter((id) => !mutedSet.has(id)) } }).lean();

  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await sender({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 60 * 60 * 24 });
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
        } else {
          console.error("[push]", err.statusCode || "", err.message);
        }
      }
    })
  );
  return sent;
};

// Called for every saved Notification (models/Notification.js)
export const pushNotificationDoc = async (doc) => {
  if (!configure()) return;
  const recipient = await User.findById(doc.recipient).select("role").lean();
  const text =
    doc.type === "task_status" && doc.actorName
      ? `${doc.actorName} changed "${doc.taskName}" ${doc.fromStatus} → ${doc.toStatus}`
      : doc.message || doc.taskName || "";
  await sendPushToUsers([doc.recipient], {
    title: TITLES[doc.type] || "Notification",
    body: text.slice(0, 240),
    url: urlFor(doc.type, recipient?.role),
    tag: `notification-${doc._id}`,
  });
};

// New chat message → push to everyone else in the conversation
export const pushChatMessage = async (recipientIds, { conversationId, senderName, text, attachments = 0, chatName = "" }) => {
  const preview = text ? text.slice(0, 160) : attachments ? `📎 ${attachments > 1 ? `${attachments} files` : "Attachment"}` : "New message";
  await sendPushToUsers(recipientIds, {
    title: chatName ? `${senderName} · ${chatName}` : `New message from ${senderName}`,
    body: preview,
    url: "/dashboard/chats",
    tag: `chat-${conversationId}`, // one notification per chat, replaced by the latest message
    kind: "chat",
  });
};
