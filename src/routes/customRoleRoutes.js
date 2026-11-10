import express from "express";
import { requirePermission } from "../middleware/permissionMiddleware.js";
import {
  listCustomRoles,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
} from "../controllers/customRoleController.js";

const router = express.Router();

router.get("/", requirePermission("users", "view"), listCustomRoles);
// Creating / changing roles = handing out access → users.assign
router.post("/", requirePermission("users", "assign"), createCustomRole);
router.put("/:id", requirePermission("users", "assign"), updateCustomRole);
router.delete("/:id", requirePermission("users", "assign"), deleteCustomRole);

export default router;
