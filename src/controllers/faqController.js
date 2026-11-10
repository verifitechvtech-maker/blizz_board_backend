const FAQ = require("../models/FAQ");

// Default FAQs (same as the ones in your React frontend)
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

// @route   GET /api/faqs
// @desc    Get all FAQs (optional ?search=keyword)
// @access  Public
exports.getFaqs = async (req, res, next) => {
  try {
    const { search } = req.query;
    const filter = {};

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      filter.$or = [{ question: regex }, { answer: regex }];
    }

    const faqs = await FAQ.find(filter).sort({ createdAt: 1 });

    res.json({
      success: true,
      count: faqs.length,
      data: faqs,
    });
  } catch (err) {
    next(err);
  }
};

// @route   POST /api/faqs
// @desc    Create a new FAQ
// @access  Public (protect later with auth)
exports.createFaq = async (req, res, next) => {
  try {
    const { question, answer } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        success: false,
        message: "Question is required",
      });
    }

    if (!answer || !answer.trim()) {
      return res.status(400).json({
        success: false,
        message: "Answer is required",
      });
    }

    const faq = await FAQ.create({
      question: question.trim(),
      answer: answer.trim(),
    });

    res.status(201).json({
      success: true,
      data: faq,
    });
  } catch (err) {
    next(err);
  }
};

// @route   PUT /api/faqs/:id
// @desc    Update an FAQ
// @access  Public (protect later with auth)
exports.updateFaq = async (req, res, next) => {
  try {
    const updates = {};
    if (req.body.question) updates.question = req.body.question.trim();
    if (req.body.answer) updates.answer = req.body.answer.trim();

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields to update",
      });
    }

    const faq = await FAQ.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!faq) {
      return res.status(404).json({
        success: false,
        message: "FAQ not found",
      });
    }

    res.json({
      success: true,
      data: faq,
    });
  } catch (err) {
    next(err);
  }
};

// @route   DELETE /api/faqs/:id
// @desc    Delete an FAQ
// @access  Public (protect later with auth)
exports.deleteFaq = async (req, res, next) => {
  try {
    const faq = await FAQ.findByIdAndDelete(req.params.id);

    if (!faq) {
      return res.status(404).json({
        success: false,
        message: "FAQ not found",
      });
    }

    res.json({
      success: true,
      message: "FAQ deleted successfully",
    });
  } catch (err) {
    next(err);
  }
};

// @route   POST /api/faqs/seed
// @desc    Seed default FAQs (only runs if collection is empty)
// @access  Public
exports.seedFaqs = async (req, res, next) => {
  try {
    const count = await FAQ.countDocuments();

    if (count > 0) {
      return res.json({
        success: true,
        message: "FAQs already seeded. No action taken.",
        existingCount: count,
      });
    }

    const faqs = await FAQ.insertMany(defaultFaqs);

    res.status(201).json({
      success: true,
      message: "Default FAQs seeded successfully",
      count: faqs.length,
      data: faqs,
    });
  } catch (err) {
    next(err);
  }
};