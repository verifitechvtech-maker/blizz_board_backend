import mongoose from "mongoose";

export const TASK_STATUSES = ["To Do", "In Progress", "Review", "Completed"];
export const TASK_PRIORITIES = ["Low", "Medium", "High", "Critical"];
export const RECURRENCE_INTERVALS = ["Every day", "Every week", "Every month"];
export const TASK_TYPES = ["standard", "monthly", "rework"];
export const TRACKING_METHODS = ["number", "checkbox"];

// Monthly Task — a target for a date range (start → end), tracked day by day
// (daily entries live in models/MonthlyProgress.js, one per task + user + date)
const monthlySchema = new mongoose.Schema(
  {
    year: { type: Number, required: true, min: 2000, max: 2100 },
    month: { type: Number, required: true, min: 1, max: 12 },
    // "YYYY-MM-DD" — the days that are tracked (year/month above = the start's month)
    // older tasks have none: they cover their whole month
    startDate: { type: String, default: null },
    endDate: { type: String, default: null },
    target: { type: Number, required: true, min: 1 },
    // number → the assignee types how many were done; checkbox → ticks the day as done
    trackingMethod: { type: String, enum: TRACKING_METHODS, default: "number" },
    // checkbox tracking: units one ticked day adds to the total
    unitPerCheck: { type: Number, min: 1, default: 1 },
    // Sum of the daily counts — recalculated from MonthlyProgress after every update
    totalCompleted: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

export const CHECKLIST_TYPES = ["Check", "Text", "Number"];

// Checklist row: what to check, how it is answered, and who does it
const checklistItemSchema = new mongoose.Schema(
  {
    desc: { type: String, required: true, trim: true, maxlength: 300 },
    type: { type: String, enum: CHECKLIST_TYPES, default: "Check" },
    employee: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
    },
    done: { type: Boolean, default: false },
    value: { type: String, default: "" }, // answer for Text / Number rows
    doneAt: { type: Date, default: null },
    doneBy: { type: String, default: "" },
  },
  { _id: true }
);

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    size: { type: Number, default: 0 },
    url: { type: String, default: "" },
    // Stored file name on disk (uploads/tasks/<filename>) — file bytes never go in MongoDB
    filename: { type: String, default: "" },
    mimetype: { type: String, default: "" },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const subtaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    completed: { type: Boolean, default: false },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    dueDate: { type: Date, default: null },
    attachments: { type: [attachmentSchema], default: [] },
    // Who gave this subtask to the assignee (the main task's assigner, a manager…)
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedByName: { type: String, default: "" },
    assignedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: true }
);

// 📌 Status change history: who changed, when, from → to
const statusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true, enum: TASK_STATUSES },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    changedByName: { type: String, default: "" },
    note: { type: String, default: "" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// 💬 Review comment the assigner writes when approving or sending the task back — shown to the assignee
const reviewCommentSchema = new mongoose.Schema(
  {
    // comment = a message either person adds any time; submitted = the assignee's note when sending the task for Review (shown to the assigner)
    decision: { type: String, enum: ["comment", "submitted", "completed", "rework"], required: true },
    text: { type: String, trim: true, maxlength: 2000, default: "" },
    score: { type: Number, min: 1, max: 10, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const taskSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Task name is required"], trim: true },
    referenceId: { type: String, trim: true, default: "" },
    description: { type: String, default: "" },
    // primary department (first selected) — used by filters, reports and Manager visibility
    department: { type: String, trim: true, default: "", index: true },
    // every selected department (names + ids); department above = departments[0]
    departments: { type: [String], default: [], index: true },
    departmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Department" }],

    // ⭐⭐⭐ NEW — DATA ISOLATION KEY
    admin_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },

    // ⭐⭐⭐ NEW — TASK BANK FLAG
    // When true, this task is a TEMPLATE saved in the Task Bank (not yet assigned).
    // When false (default), this is a real assigned task.
    isTaskBank: {
      type: Boolean,
      default: false,
      index: true,
    },

    // 👤 ASSIGNMENT
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedAt: { type: Date, default: Date.now },

    // Tasks cloned for multi-user assignment share this id
    taskGroupId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    // Task Bank template this task was assigned from (if any)
    sourceTemplate: { type: mongoose.Schema.Types.ObjectId, ref: "TaskBank", default: null },

    // Start → end (end = dueDate + dueTime); the card shows the length: "7 hours" / "3 days"
    startDate: { type: Date, default: null },
    startTime: { type: String, default: "" }, // "HH:mm"
    dueDate: { type: Date },
    dueTime: { type: String, default: "" }, // "HH:mm" — shown on the calendar
    // Reminder the assigner picks: at the start, 15 min / 1 hour / 1 day before the end, or a custom time
    reminder: {
      option: { type: String, enum: ["none", "at_start", "before_15m", "before_1h", "before_1d", "custom"], default: "none" },
      customAt: { type: String, default: "" }, // "YYYY-MM-DDTHH:mm" (custom only)
      at: { type: Date, default: null },       // when it goes out (worked out on save)
      sentAt: { type: Date, default: null },
    },
    // Named reminders: "Call the client" at 01 Nov 10:30 — each sent once to the assignee
    reminders: [
      {
        title: { type: String, trim: true, maxlength: 120, required: true },
        customAt: { type: String, required: true }, // "YYYY-MM-DDTHH:mm" in TASK_TIME_ZONE
        at: { type: Date, required: true },
        sentAt: { type: Date, default: null },
      },
    ],
    priority: { type: String, enum: TASK_PRIORITIES, default: "Medium", index: true },
    complexity: { type: Number, min: 0, max: 100, default: 0 },
    reward: { type: Number, min: 0, default: 10 },

    taskType: { type: String, enum: TASK_TYPES, default: "standard", index: true },
    // Rework task → the original task it redoes (its own referenceId stays separate)
    reworkOf: {
      task: { type: mongoose.Schema.Types.ObjectId, ref: "Task", default: null },
      referenceId: { type: String, default: "" },
      name: { type: String, default: "" },
      departments: { type: [String], default: [] },
    },
    monthly: { type: monthlySchema, default: null },

    recurring: { type: Boolean, default: false },
    recurrenceInterval: { type: String, enum: RECURRENCE_INTERVALS, default: "Every week" },

    attachments: { type: [attachmentSchema], default: [] },
    subtasks: { type: [subtaskSchema], default: [] },
    checklist: { type: [checklistItemSchema], default: [] },

    // 📧 Which task emails were already sent (reset when deadline or assignee changes)
    notifications: {
      assignedAt: { type: Date, default: null },
      reminder3hAt: { type: Date, default: null },
      reminder1hAt: { type: Date, default: null },
      overdueAlertAt: { type: Date, default: null },
    },

    // 🔄 STATUS
    status: { type: String, enum: TASK_STATUSES, default: "To Do", index: true },
    statusHistory: { type: [statusHistorySchema], default: [] },
    // Times the assigner sent the task back from Review for rework
    reworkCount: { type: Number, default: 0 },
    // Score 1–10 the assigner gave when approving the task — added to the assignee's points
    reviewScore: { type: Number, min: 1, max: 10, default: null },
    // Every review comment (newest last) — the latest one is shown on the assignee's task card
    reviewComments: { type: [reviewCommentSchema], default: [] },
    // Points given when it was completed — taken back exactly if reopened
    pointsAwarded: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },

    // 📧 The assignee's activity from the assignment email (task page opened from the email link)
    emailActivity: {
      viewedAt: { type: Date, default: null },      // first time
      lastViewedAt: { type: Date, default: null },
      lastUpdateAt: { type: Date, default: null },  // last status change made from the email
    },
  },
  { timestamps: true }
);

const Task = mongoose.model("Task", taskSchema);
export default Task;
