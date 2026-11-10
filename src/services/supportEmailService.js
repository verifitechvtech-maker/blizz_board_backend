// Support ticket emails: new ticket → Super Admin(s); reply / status change → the user.
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { send, layout, button, escapeHtml, frontendUrl } from "./accountEmailService.js";

const safe = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    console.error("[supportEmail]", err.message);
    return null;
  }
};

const ticketBlock = (t) => `
  <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px">
    <tr><td style="padding:5px 0;color:#6E8799;width:110px">Ticket</td><td><strong>${escapeHtml(t.ticketId)}</strong></td></tr>
    <tr><td style="padding:5px 0;color:#6E8799">Subject</td><td>${escapeHtml(t.subject)}</td></tr>
    <tr><td style="padding:5px 0;color:#6E8799">Category</td><td>${escapeHtml(t.category)}</td></tr>
    <tr><td style="padding:5px 0;color:#6E8799">Priority</td><td>${escapeHtml(t.priority)}</td></tr>
    <tr><td style="padding:5px 0;color:#6E8799">Status</td><td>${escapeHtml(t.status)}</td></tr>
  </table>`;

export const notifySuperAdminsNewTicket = safe(async (ticket, raiser) => {
  const admins = await User.find({ role: "SuperAdmin", status: "Active" }).select("name email preferences");
  const link = `${frontendUrl()}/superadmin/dashboard`;
  // In-app + real-time for every Super Admin
  await Promise.all(
    admins.map((a) =>
      Notification.create({
        recipient: a._id,
        admin_id: ticket.admin_id || null,
        type: "support_ticket",
        actor: raiser._id,
        actorName: raiser.name,
        taskName: ticket.ticketId,
        message: `${raiser.name} raised ${ticket.ticketId}: ${ticket.subject}`,
      }).catch(() => null)
    )
  );
  await Promise.all(
    admins
      .filter((a) => a.preferences?.emailNotifications !== false)
      .map((a) =>
        send({
          to: a.email,
          subject: `New support ticket ${ticket.ticketId}: ${ticket.subject}`,
          text: `Hi ${a.name},\n\n${raiser.name} (${raiser.email}) raised a support ticket.\n\n${ticket.ticketId} — ${ticket.subject}\nCategory: ${ticket.category}\nPriority: ${ticket.priority}\n\n${ticket.message}\n\nOpen: ${link}`,
          html: layout("New support ticket", `
            <p>Hi <strong>${escapeHtml(a.name)}</strong>,</p>
            <p><strong>${escapeHtml(raiser.name)}</strong> (${escapeHtml(raiser.email)}) raised a support ticket.</p>
            ${ticketBlock(ticket)}
            <div style="padding:12px 14px;background:#F2FBFC;border-left:3px solid #16A6B8;border-radius:6px;white-space:pre-wrap">${escapeHtml(ticket.message)}</div>
            ${button(link, "Open Super Admin dashboard")}`),
        })
      )
  );
});

export const notifyTicketOwnerUpdate = safe(async (ticket, { reply, statusChanged }) => {
  if (!ticket.user) return;
  const owner = await User.findById(ticket.user).select("name email preferences status");
  if (!owner || owner.status === "Inactive") return;
  await Notification.create({
    recipient: owner._id,
    admin_id: ticket.admin_id || null,
    type: "support_reply",
    actor: reply?.by || null,
    actorName: reply?.byName || "",
    taskName: ticket.ticketId,
    message: reply
      ? `${reply.byName} replied to ${ticket.ticketId}: ${reply.message.slice(0, 120)}`
      : `${ticket.ticketId} is now ${ticket.status}`,
  }).catch(() => null);
  if (owner.preferences?.emailNotifications === false) return;
  const link = `${frontendUrl()}/dashboard/support`;
  const title = reply ? "New reply to your support ticket" : `Your ticket is now ${ticket.status}`;
  await send({
    to: owner.email,
    subject: reply
      ? `Reply on ${ticket.ticketId}: ${ticket.subject}`
      : `${ticket.ticketId} is now ${ticket.status}: ${ticket.subject}`,
    text: `Hi ${owner.name},\n\n${reply ? `${reply.byName} replied:\n${reply.message}\n\n` : ""}${statusChanged ? `Status: ${ticket.status}\n` : ""}\nOpen: ${link}`,
    html: layout(title, `
      <p>Hi <strong>${escapeHtml(owner.name)}</strong>,</p>
      ${reply ? `<p><strong>${escapeHtml(reply.byName)}</strong> replied to your ticket:</p>
      <div style="padding:12px 14px;background:#F2FBFC;border-left:3px solid #16A6B8;border-radius:6px;white-space:pre-wrap">${escapeHtml(reply.message)}</div>` : ""}
      ${ticketBlock(ticket)}
      ${button(link, "View my tickets")}`),
  });
});
