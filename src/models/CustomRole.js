import mongoose from "mongoose";

// Organization-defined roles (like departments): e.g. "Consultant", "Team Lead".
// Each sits on a base access level (Manager / User) and may override its permissions.
const customRoleSchema = new mongoose.Schema(
  {
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: [true, "Role name is required"], trim: true, maxlength: 60 },
    description: { type: String, trim: true, default: "", maxlength: 300 },
    baseRole: { type: String, enum: ["Manager", "User"], default: "User" },
    // null → same permissions as the base role in this organization
    permissions: { type: mongoose.Schema.Types.Mixed, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false }
);

customRoleSchema.index(
  { admin_id: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } } // case-insensitive per org
);

export default mongoose.models.CustomRole || mongoose.model("CustomRole", customRoleSchema);
