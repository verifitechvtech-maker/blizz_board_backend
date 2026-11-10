import mongoose from "mongoose";

// One daily entry of a Monthly Task: what ONE assigned user did on ONE date
// (user = the assignee, even when the task's creator corrects the entry).
// A date without an entry counts as 0 — nothing is ever assumed done.
const monthlyProgressSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // "YYYY-MM-DD"
    count: {
      type: Number,
      min: 0,
      default: 0,
      validate: { validator: Number.isInteger, message: "Count must be a whole number" },
    },
    checked: { type: Boolean, default: false },
    remarks: { type: String, trim: true, maxlength: 500, default: "" },
    // who saved it last: the assignee (today) or the task's creator (corrections)
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// No duplicate entries for the same task, user and date
monthlyProgressSchema.index({ task: 1, user: 1, date: 1 }, { unique: true });

export default mongoose.models.MonthlyProgress ||
  mongoose.model("MonthlyProgress", monthlyProgressSchema);
