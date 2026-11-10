// Create-task-by-email: read the task inbox over IMAP every minute.
//
// .env
//   TASK_INBOX_ENABLED=true
//   TASK_INBOX_ADDRESS=yourname+tasks@gmail.com   ← the address people send tasks to
//   TASK_INBOX_IMAP_HOST=imap.gmail.com            (default)
//   TASK_INBOX_IMAP_PORT=993                       (default)
//   TASK_INBOX_USER / TASK_INBOX_PASS              (default: SMTP_USER / SMTP_PASS — a Gmail app password works for both)
//
// Only UNREAD mail addressed to TASK_INBOX_ADDRESS is touched (other mail in the same
// mailbox is left alone); each processed email is marked as read.
import cron from "node-cron";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { processInboundEmail, inboxAddress } from "../services/emailTaskService.js";

const MAX_PER_RUN = 25;

const settings = () => ({
  host: process.env.TASK_INBOX_IMAP_HOST || "imap.gmail.com",
  port: Number(process.env.TASK_INBOX_IMAP_PORT) || 993,
  user: String(process.env.TASK_INBOX_USER || process.env.SMTP_USER || "").trim(),
  pass: String(process.env.TASK_INBOX_PASS || process.env.SMTP_PASS || "").trim().replace(/\s+/g, ""),
});

export const emailTasksEnabled = () =>
  String(process.env.TASK_INBOX_ENABLED || "").toLowerCase() === "true" && Boolean(inboxAddress());

const addressesOf = (field) =>
  (Array.isArray(field) ? field : field ? [field] : []).flatMap((f) => (f.value || []).map((v) => v.address)).filter(Boolean);

/** The TOP Authentication-Results header = the one our own mail server added */
const topAuthResults = (parsed) =>
  (parsed.headerLines || []).find((h) => h.key === "authentication-results")?.line.replace(/^[^:]+:\s*/, "") || "";

const headerText = (parsed, key) => {
  const v = parsed.headers?.get(key);
  return typeof v === "string" ? v : v?.value || v?.text || "";
};

/** mailparser result → the plain object processInboundEmail expects */
export const toInboundMail = (parsed) => ({
  messageId: parsed.messageId || "",
  date: parsed.date ? parsed.date.toISOString() : "",
  from: parsed.from?.value?.[0]?.address || "",
  to: addressesOf(parsed.to),
  cc: addressesOf(parsed.cc),
  subject: parsed.subject || "",
  text: parsed.text || "",
  attachments: parsed.attachments || [],
  authResults: topAuthResults(parsed),
  autoSubmitted: headerText(parsed, "auto-submitted"),
  precedence: headerText(parsed, "precedence"),
});

export const pollTaskInbox = async () => {
  const { host, port, user, pass } = settings();
  if (!user || !pass) throw new Error("TASK_INBOX_USER / TASK_INBOX_PASS (or SMTP_USER / SMTP_PASS) are not set");

  const client = new ImapFlow({ host, port, secure: port === 993, auth: { user, pass }, logger: false });
  const counts = { created: 0, rejected: 0, ignored: 0, duplicate: 0 };
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const address = inboxAddress();
    // Gmail: "deliveredto" also finds mail where the task address was in BCC
    const query = /gmail\.com$/i.test(host)
      ? { seen: false, gmraw: `deliveredto:${address}` }
      : { seen: false, or: [{ to: address }, { cc: address }] };
    const uids = (await client.search(query, { uid: true })) || [];

    for (const uid of uids.slice(0, MAX_PER_RUN)) {
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        const result = await processInboundEmail(toInboundMail(await simpleParser(msg.source)));
        counts[result.status] = (counts[result.status] || 0) + 1;
      } catch (err) {
        // left unread → tried again next minute (the Message-ID check prevents doubles)
        console.error("Email task: could not process message", uid, err.message);
        continue;
      }
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return counts;
};

export const startEmailTaskInboxJob = () => {
  if (!emailTasksEnabled()) {
    console.log("Create-task-by-email is off (set TASK_INBOX_ENABLED=true and TASK_INBOX_ADDRESS to turn it on)");
    return;
  }
  let running = false;
  let lastError = "";
  cron.schedule("* * * * *", async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const counts = await pollTaskInbox();
      if (counts.created || counts.rejected) console.log("Tasks by email:", counts);
      lastError = "";
    } catch (err) {
      // log a repeating error (wrong password, no network) only once
      if (err.message !== lastError) console.error("Task inbox check failed:", err.message);
      lastError = err.message;
    } finally {
      running = false;
    }
  });
  console.log(`Create-task-by-email is on — send tasks to ${inboxAddress()}`);
};
