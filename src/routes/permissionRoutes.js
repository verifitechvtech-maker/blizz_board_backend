import express from "express";
import {
  getCatalog,
  getMyPermissions,
  getOrgRoles,
  updateOrgRole,
  resetOrgRole,
  getAdminAccess,
  updateAdminAccess,
  updateCustomRolePermissions,
  getIndividualAccess,
  updateIndividualAccess,
} from "../controllers/permissionController.js";
import { authorize } from "../middleware/role.js";

const router = express.Router();

// Any authenticated user
router.get("/catalog", getCatalog);
router.get("/me", getMyPermissions);

// Admin → configure his organization's Manager / User roles
router.get("/roles", authorize("Admin"), getOrgRoles);
router.put("/roles/:role", authorize("Admin"), updateOrgRole);
router.delete("/roles/:role", authorize("Admin"), resetOrgRole);
router.put("/custom-roles/:id", authorize("Admin"), updateCustomRolePermissions);
// Admin → individual access for one person (overrides their role)
router.get("/users", authorize("Admin"), getIndividualAccess);
router.put("/users/:id", authorize("Admin"), updateIndividualAccess);

// SuperAdmin → manage what each Admin can use and grant
router.get("/admins", authorize("SuperAdmin"), getAdminAccess);
router.put("/admins/:id", authorize("SuperAdmin"), updateAdminAccess);

export default router;
