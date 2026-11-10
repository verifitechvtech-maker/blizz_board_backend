const Ticket = require("../models/Ticket");

// @route   POST /api/tickets
// @desc    Create a support ticket (matches frontend ticket form)
// @access  Public
exports.createTicket = async (req, res, next) => {
  try {
    const { subject, category, priority, message, userEmail } = req.body;

    // Validation — same as frontend required fields
    if (!subject || !subject.trim()) {
      return res.status(400).json({
        success: false,
        message: "Subject is required",
      });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message is required",
      });
    }

    const ticket = await Ticket.create({
      subject: subject.trim(),
      category: category || "General Support",
      priority: priority || "Medium",
      message: message.trim(),
      userEmail: userEmail || "",
    });

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
    next(err);
  }
};

// @route   GET /api/tickets
// @desc    Get all tickets (filters: ?status=&priority=&category=&search=)
// @access  Public (protect later with admin auth)
exports.getTickets = async (req, res, next) => {
  try {
    const { status, priority, category, search } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (category) filter.category = category;

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      filter.$or = [{ subject: regex }, { message: regex }];
    }

    const tickets = await Ticket.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: tickets.length,
      data: tickets,
    });
  } catch (err) {
    next(err);
  }
};

// @route   GET /api/tickets/stats
// @desc    Get ticket statistics for dashboard
// @access  Public (protect later with admin auth)
exports.getTicketStats = async (req, res, next) => {
  try {
    const total = await Ticket.countDocuments();
    const open = await Ticket.countDocuments({ status: "Open" });
    const inProgress = await Ticket.countDocuments({
      status: "In Progress",
    });
    const resolved = await Ticket.countDocuments({ status: "Resolved" });
    const closed = await Ticket.countDocuments({ status: "Closed" });

    res.json({
      success: true,
      data: { total, open, inProgress, resolved, closed },
    });
  } catch (err) {
    next(err);
  }
};

// @route   GET /api/tickets/:id
// @desc    Get single ticket by MongoDB ID
// @access  Public (protect later with admin auth)
exports.getTicket = async (req, res, next) => {
  try {
    const ticket = await Ticket.findById(req.params.id);

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    res.json({
      success: true,
      data: ticket,
    });
  } catch (err) {
    next(err);
  }
};

// @route   PATCH /api/tickets/:id
// @desc    Update ticket status / priority / email
// @access  Public (protect later with admin auth)
exports.updateTicket = async (req, res, next) => {
  try {
    const allowed = ["status", "priority", "userEmail"];
    const updates = {};

    allowed.forEach((key) => {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields to update. Allowed: status, priority, userEmail",
      });
    }

    const ticket = await Ticket.findByIdAndUpdate(
      req.params.id,
      updates,
      {
        new: true,
        runValidators: true,
      }
    );

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    res.json({
      success: true,
      message: "Ticket updated successfully",
      data: ticket,
    });
  } catch (err) {
    next(err);
  }
};

// @route   DELETE /api/tickets/:id
// @desc    Delete a ticket
// @access  Public (protect later with admin auth)
exports.deleteTicket = async (req, res, next) => {
  try {
    const ticket = await Ticket.findByIdAndDelete(req.params.id);

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    res.json({
      success: true,
      message: "Ticket deleted successfully",
    });
  } catch (err) {
    next(err);
  }
};