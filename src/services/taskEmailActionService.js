// Task actions from the assignment email (no login needed)
//   • the email carries a signed link per assignee: /task-action/<token>
//   • the link opens a small page that shows the task and records "viewed"
//   • a status change needs a click on that page (POST) — mail scanners that
//     pre-open links can never change a task on their own
// The token is signed with its own secret, so it can never be used as a login token.
import jwt from "jsonwebtoken";
import { frontendUrl } from "./accountEmailService.js";

const PURPOSE = "task-email-action";
const LIFETIME = process.env.TASK_EMAIL_LINK_TTL || "30d";

const secret = () => `${process.env.JWT_SECRET}:${PURPOSE}`;

/** Statuses the assignee may choose from the email (Completed stays with the assigner's review). */
export const EMAIL_STATUSES = ["In Progress", "Review"];

/** What the assignee can move the task to right now. */
export const emailStatusOptions = (task) => {
  if (!task || task.status === "Completed" || task.status === "Review") return [];
  return EMAIL_STATUSES.filter((status) => status !== task.status);
};

export const createActionToken = (task, assigneeId = task.assignedTo) =>
  jwt.sign({ purpose: PURPOSE, t: String(task._id), u: String(assigneeId) }, secret(), { expiresIn: LIFETIME });

/** → { taskId, userId } or null (bad / expired / not ours) */
export const readActionToken = (token) => {
  try {
    const data = jwt.verify(String(token || ""), secret());
    if (data?.purpose !== PURPOSE || !data.t || !data.u) return null;
    return { taskId: data.t, userId: data.u };
  } catch {
    return null;
  }
};

export const actionLink = (token, status = "") =>
  `${frontendUrl()}/task-action/${encodeURIComponent(token)}${status ? `?status=${encodeURIComponent(status)}` : ""}`;
