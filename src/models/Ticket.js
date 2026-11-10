import mongoose from "mongoose";

const ticketSchema = new mongoose.Schema(
  {
    ticketId: {
      type: String,
      unique: true,
    },
    // Auto-linked to the logged-in user (set by authenticate middleware)
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    userEmail: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
    },
    subject: {
      type: String,
      required: [true, "Subject is required"],
      trim: true,
      maxlength: 150,
    },
    category: {
      type: String,
      enum: [
        "General Support",
        "Tasks",
        "Task Bank",
        "Users",
        "Calendar",
        "Account",
        "Technical Issue",
      ],
      default: "General Support",
    },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High", "Urgent"],
      default: "Medium",
    },
    message: {
      type: String,
      required: [true, "Message is required"],
      trim: true,
      maxlength: 3000,
    },
    status: {
      type: String,
      enum: ["Open", "In Progress", "Resolved", "Closed"],
      default: "Open",
    },
    // Organization of the person who raised it (null for an Admin's own ticket)
    admin_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Conversation between the user and the support team (Super Admin)
    responses: [
      {
        _id: false,
        message: { type: String, required: true, trim: true, maxlength: 3000 },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        byName: { type: String, default: "" },
        byRole: { type: String, default: "" },
        at: { type: Date, default: Date.now },
      },
    ],
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Auto-generate ticket ID: TKT-00001, TKT-00002, ...
ticketSchema.pre("validate", async function (next) {
  if (this.isNew && !this.ticketId) {
    try {
      const last = await mongoose
        .model("Ticket")
        .findOne()
        .sort({ createdAt: -1 })
        .select("ticketId");

      let nextNum = 1;
      if (last?.ticketId) {
        const parsed = parseInt(last.ticketId.split("-")[1], 10);
        if (!isNaN(parsed)) nextNum = parsed + 1;
      }

      this.ticketId = `TKT-${String(nextNum).padStart(5, "0")}`;
    } catch (err) {
      return next(err);
    }
  }
  next();
});

const Ticket = mongoose.model("Ticket", ticketSchema);

export default Ticket;