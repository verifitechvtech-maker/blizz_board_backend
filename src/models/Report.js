import mongoose from "mongoose";

const departmentStatSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    total: Number,
    completed: Number,
    early: Number,
    onTime: Number,
    late: Number,
    review: Number,
    progress: Number,
    pending: Number,
    overdue: Number,
  },
  { _id: false }
);

const priorityStatSchema = new mongoose.Schema(
  {
    name: { type: String, enum: ["High", "Medium", "Low"] },
    count: Number,
    value: Number,
  },
  { _id: false }
);

const reportSchema = new mongoose.Schema(
  {
    reportType: { type: String, default: "Task Summary" },
    dateRange: { type: String, default: "All time" },
    department: { type: String, default: "All Departments" },
    referenceId: { type: String, default: "All Reference IDs" },

    totals: {
      total: Number,
      completed: Number,
      early: Number,
      onTime: Number,
      late: Number,
      review: Number,
      progress: Number,
      pending: Number,
      overdue: Number,
    },
    completionRate: Number,

    departments: [departmentStatSchema],
    priorities: [priorityStatSchema],

    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model("Report", reportSchema);
