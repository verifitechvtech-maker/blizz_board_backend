import mongoose from "mongoose";

const taskBankSchema = new mongoose.Schema(
  {
    title:         { type: String, required: true, trim: true },
    description:   { type: String, required: true, trim: true },
    category:      { type: String, default: "General", trim: true },
    department:    { type: String, default: "Management", trim: true },
    type:          { type: String, enum: ["Template", "Idea"], default: "Template" },
    priority:      { type: String, enum: ["High", "Medium", "Low"], default: "Medium" },
    status:        { type: String, enum: ["Ready to Assign", "Draft"], default: "Ready to Assign" },
    estimatedTime: { type: String, default: "1 hour" },
    createdBy:     { type: String, default: "Admin User" },   // ⬅ keep: display name (React shows this)
    tags:          [{ type: String, trim: true }],
    // Files kept with the template (disk: uploads/tasks) — copied onto every task assigned from it
    attachments: [
      {
        _id: false,
        name: { type: String, required: true },
        size: { type: Number, default: 0 },
        filename: { type: String, required: true },
        mimetype: { type: String, default: "" },
        url: { type: String, default: "" },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    usageCount:    { type: Number, default: 0 },

    // ⭐⭐⭐ NEW — DATA ISOLATION (the ONLY changes)
    admin_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },
    isGlobal: {
      type: Boolean,
      default: false,   // true = SuperAdmin template → visible to ALL admins
    },
    creatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,    // real user who created (for update/delete permission)
    },
    // Every real Task created from this template (name snapshot survives user deletion)
    assignments: [
      {
        _id: false,
        task: { type: mongoose.Schema.Types.ObjectId, ref: "Task" },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        userName: { type: String, default: "" },
        admin_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        assignedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

taskBankSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret) => {
    if (ret.createdAt) ret.createdAt = new Date(ret.createdAt).toISOString().split("T")[0];
    if (ret.updatedAt) ret.updatedAt = new Date(ret.updatedAt).toISOString().split("T")[0];
    return ret;
  },
});

export default mongoose.model("TaskBank", taskBankSchema);