import mongoose from "mongoose";

const taskCalendarSchema = new mongoose.Schema(
  {
    title:       { type: String, required: true, trim: true },
    due_date:    { type: String, required: true },  // "YYYY-MM-DD" — calendar day
    time:        { type: String, default: "09:00" },
    department:  { type: String, default: "Management" },
    assigned_to: { type: String, default: "" },
    priority:    { type: String, default: "Medium" },
    status:      { type: String, default: "Pending" },
    description: { type: String, default: "" },

    // ⭐⭐⭐ NEW — DATA ISOLATION (the ONLY changes)
    admin_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model("TaskCalendar", taskCalendarSchema); // ✅ ESM export