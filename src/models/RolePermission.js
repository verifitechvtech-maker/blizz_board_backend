import mongoose from "mongoose";

// Per-organization permission set for a member role (Manager / User).
// One document per (admin_id, role). Missing document → DEFAULT_ROLE_PERMISSIONS.
const rolePermissionSchema = new mongoose.Schema(
  {
    admin_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["Manager", "User"],
      required: true,
    },
    permissions: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true, minimize: false }
);

rolePermissionSchema.index({ admin_id: 1, role: 1 }, { unique: true });

const RolePermission =
  mongoose.models.RolePermission ||
  mongoose.model("RolePermission", rolePermissionSchema);

export default RolePermission;
