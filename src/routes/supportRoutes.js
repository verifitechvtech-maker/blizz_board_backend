import express from "express";
import Faq from "../models/Faq.js";
import Ticket from "../models/Ticket.js";
import { attachOrgUsers } from "../middleware/orgScope.js";
import User from "../models/User.js";
import { notifySuperAdminsNewTicket, notifyTicketOwnerUpdate } from "../services/supportEmailService.js";

const TICKET_STATUSES = ["Open", "In Progress", "Resolved", "Closed"];

const router = express.Router();

// ⭐ Ticket visibility:
//   SuperAdmin → all | Admin / Manager → tickets raised inside their organization
//   User → only his own tickets
router.use("/tickets", attachOrgUsers);
const ticketScope = (req) => {
  if (req.user.role === "SuperAdmin") return {};
  if (["Admin", "Manager"].includes(req.user.role)) return { user: { $in: req.orgUserIds || [] } };
  return { user: req.user._id };
};
// Status / priority / delete: the ticket owner, or the org's Admin / SuperAdmin
const manageScope = (req) =>
  ["SuperAdmin", "Admin"].includes(req.user.role) ? ticketScope(req) : { user: req.user._id };

// FAQs are shared help content — only SuperAdmin / Admin may change them
const faqEditor = (req, res, next) =>
  ["SuperAdmin", "Admin"].includes(req.user?.role)
    ? next()
    : res.status(403).json({ success: false, message: "Only administrators can manage FAQs" });

// ============================================================
// FAQs
// ============================================================

const defaultFaqs = [
  {
    question: "How do I create a new task?",
    answer:
      "Open the Tasks section and select New Task. Enter the task title, description, department, assignee, priority and due date, then save the task.",
  },
  {
    question: "How can I assign a task to a user?",
    answer:
      "Create or open a task and select the required user from the Assignee field. The assigned user will then see the task in their task workspace.",
  },
  {
    question: "What is the Task Bank?",
    answer:
      "Task Bank is a reusable repository where you can save task ideas and templates. Saved templates can later be assigned as real tasks.",
  },
  {
    question: "How do I manage users?",
    answer:
      "Use the Users section to create, edit and manage users. Administrators can manage users according to their assigned access permissions.",
  },
  {
    question: "Can I track overdue tasks?",
    answer:
      "Yes. Dashboard statistics and task views can show overdue tasks so you can quickly identify work that requires attention.",
  },
  {
    question: "How do I change my profile information?",
    answer:
      "Open Settings and go to the Profile section. You can update your profile information and other available account preferences.",
  },
];

// GET /api/support/faqs?search=keyword
router.get("/faqs", async (req, res) => {
  try {
    const { search } = req.query;
    const filter = {};

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      filter.$or = [{ question: regex }, { answer: regex }];
    }

    const faqs = await Faq.find(filter).sort({ createdAt: 1 });

    res.json({ success: true, count: faqs.length, data: faqs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/support/faqs
router.post("/faqs", faqEditor, async (req, res) => {
  try {
    const { question, answer } = req.body;

    if (!question?.trim() || !answer?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Question and answer are required",
      });
    }

    const faq = await Faq.create({
      question: question.trim(),
      answer: answer.trim(),
    });

    res.status(201).json({ success: true, data: faq });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/support/faqs/seed  (run once to insert default FAQs)
router.post("/faqs/seed", faqEditor, async (req, res) => {
  try {
    const count = await Faq.countDocuments();

    if (count > 0) {
      return res.json({
        success: true,
        message: "FAQs already seeded",
        existingCount: count,
      });
    }

    const faqs = await Faq.insertMany(defaultFaqs);

    res.status(201).json({
      success: true,
      message: "Default FAQs seeded successfully",
      count: faqs.length,
      data: faqs,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/support/faqs/:id
router.put("/faqs/:id", faqEditor, async (req, res) => {
  try {
    const updates = {};
    if (req.body.question) updates.question = req.body.question.trim();
    if (req.body.answer) updates.answer = req.body.answer.trim();

    const faq = await Faq.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!faq) {
      return res.status(404).json({ success: false, message: "FAQ not found" });
    }

    res.json({ success: true, data: faq });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid FAQ ID" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/support/faqs/:id
router.delete("/faqs/:id", faqEditor, async (req, res) => {
  try {
    const faq = await Faq.findByIdAndDelete(req.params.id);

    if (!faq) {
      return res.status(404).json({ success: false, message: "FAQ not found" });
    }

    res.json({ success: true, message: "FAQ deleted successfully" });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid FAQ ID" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// Support Tickets
// ============================================================

// POST /api/support/tickets  (matches your frontend ticket form)
router.post("/tickets", async (req, res) => {
  try {
    const { subject, category, priority, message } = req.body;

    if (!subject?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Subject is required" });
    }
    if (!message?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Message is required" });
    }

    const ticket = await Ticket.create({
      user: req.user?._id || req.user?.id || null,
      userEmail: req.user?.email || "",
      admin_id: req.user.role === "Admin" ? req.user._id : req.user.admin_id || null,
      subject: subject.trim(),
      category: category || "General Support",
      priority: priority || "Medium",
      message: message.trim(),
    });

    // ⭐ Super Admin receives it (email; the dashboard lists it)
    notifySuperAdminsNewTicket(ticket, req.user);

    res.status(201).json({
      success: true,
      message: "Support ticket created successfully",
      data: {
        id: ticket._id,
        ticketId: ticket.ticketId,
        subject: ticket.subject,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        createdAt: ticket.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/support/tickets?status=&priority=&category=&search=
router.get("/tickets", async (req, res) => {
  try {
    const { status, priority, category, search } = req.query;
    const filter = {};

    // Default: my own tickets (Support page).
    // ?scope=all → SuperAdmin: every ticket | Admin / Manager: tickets of my organization
    if (req.query.scope === "all" && ["SuperAdmin", "Admin", "Manager"].includes(req.user.role)) {
      Object.assign(filter, ticketScope(req));
    } else {
      filter.user = req.user._id;
    }

    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (category) filter.category = category;

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      filter.$or = [{ subject: regex }, { message: regex }];
    }

    const tickets = await Ticket.find(filter)
      .populate("user", "name email role department admin_id")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    // Organization name for the Super Admin view
    const orgIds = [...new Set(tickets.map((t) => String(t.admin_id || t.user?.admin_id || "")).filter(Boolean))];
    const orgs = orgIds.length ? await User.find({ _id: { $in: orgIds } }).select("name companyName").lean() : [];
    const orgName = Object.fromEntries(orgs.map((o) => [String(o._id), o.companyName || o.name]));

    const data = tickets.map((t) => ({
      ...t,
      raisedBy: t.user ? { _id: t.user._id, name: t.user.name, email: t.user.email, role: t.user.role } : null,
      user: t.user?._id || t.user,
      organization: orgName[String(t.admin_id || t.user?.admin_id || "")] ||
        (t.user?.role === "Admin" ? t.user.name : ""),
    }));

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/support/tickets/stats
// ⚠️ Must stay ABOVE "/tickets/:id"
router.get("/tickets/stats", async (req, res) => {
  try {
    const scope = req.query.scope === "all" ? ticketScope(req) : { user: req.user._id };
    const [total, open, inProgress, resolved, closed] = await Promise.all([
      Ticket.countDocuments(scope),
      Ticket.countDocuments({ ...scope, status: "Open" }),
      Ticket.countDocuments({ ...scope, status: "In Progress" }),
      Ticket.countDocuments({ ...scope, status: "Resolved" }),
      Ticket.countDocuments({ ...scope, status: "Closed" }),
    ]);

    res.json({
      success: true,
      data: { total, open, inProgress, resolved, closed },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/support/tickets/:id
router.get("/tickets/:id", async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ _id: req.params.id, ...ticketScope(req) });

    if (!ticket) {
      return res
        .status(404)
        .json({ success: false, message: "Ticket not found" });
    }

    res.json({ success: true, data: ticket });
  } catch (err) {
    if (err.name === "CastError") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid ticket ID" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/support/tickets/:id  (update status / priority)
router.patch("/tickets/:id", async (req, res) => {
  try {
    const allowed = ["status", "priority"];
    const updates = {};

    allowed.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields to update (status, priority)",
      });
    }

    if (updates.status === "Resolved" || updates.status === "Closed") updates.resolvedAt = new Date();
    else if (updates.status) updates.resolvedAt = null;

    const before = await Ticket.findOne({ _id: req.params.id, ...manageScope(req) }).select("status").lean();
    const ticket = await Ticket.findOneAndUpdate(
      { _id: req.params.id, ...manageScope(req) },
      updates,
      { new: true, runValidators: true }
    );
    if (ticket && before && updates.status && before.status !== ticket.status &&
        String(ticket.user) !== String(req.user._id)) {
      notifyTicketOwnerUpdate(ticket, { statusChanged: true });
    }

    if (!ticket) {
      return res
        .status(404)
        .json({ success: false, message: "Ticket not found" });
    }

    res.json({
      success: true,
      message: "Ticket updated successfully",
      data: ticket,
    });
  } catch (err) {
    if (err.name === "CastError") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid ticket ID" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/support/tickets/:id/reply   { message, status? }
// Support team (SuperAdmin / org Admin) or the ticket owner adds a message.
router.post("/tickets/:id/reply", async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    if (!message) return res.status(400).json({ success: false, message: "Reply message is required" });
    if (message.length > 3000) return res.status(400).json({ success: false, message: "Reply is too long (max 3000)" });

    const isStaff = ["SuperAdmin", "Admin"].includes(req.user.role);
    const ticket = await Ticket.findOne({
      _id: req.params.id,
      ...(isStaff ? ticketScope(req) : { user: req.user._id }),
    });
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

    const reply = { message, by: req.user._id, byName: req.user.name, byRole: req.user.role, at: new Date() };
    ticket.responses.push(reply);

    const owner = String(ticket.user) === String(req.user._id);
    const nextStatus = req.body.status;
    if (nextStatus && TICKET_STATUSES.includes(nextStatus) && isStaff) {
      ticket.status = nextStatus;
      ticket.resolvedAt = ["Resolved", "Closed"].includes(nextStatus) ? new Date() : null;
    } else if (isStaff && !owner && ticket.status === "Open") {
      ticket.status = "In Progress"; // first answer from support
    } else if (owner && ["Resolved", "Closed"].includes(ticket.status)) {
      ticket.status = "Open"; // user writes back → reopen
      ticket.resolvedAt = null;
    }
    await ticket.save();

    if (!owner) notifyTicketOwnerUpdate(ticket, { reply, statusChanged: true });
    else notifySuperAdminsNewTicket(ticket, req.user); // user follow-up reaches support again

    res.json({ success: true, message: "Reply sent", data: ticket });
  } catch (err) {
    if (err.name === "CastError") return res.status(400).json({ success: false, message: "Invalid ticket ID" });
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/support/tickets/:id
router.delete("/tickets/:id", async (req, res) => {
  try {
    const ticket = await Ticket.findOneAndDelete({ _id: req.params.id, ...manageScope(req) });

    if (!ticket) {
      return res
        .status(404)
        .json({ success: false, message: "Ticket not found" });
    }

    res.json({ success: true, message: "Ticket deleted successfully" });
  } catch (err) {
    if (err.name === "CastError") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid ticket ID" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;