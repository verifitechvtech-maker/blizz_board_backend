import { Router } from "express";
import { authorize } from "../middleware/authMiddleware.js";
import {
  recordPageView,
  recordLogout,
  getActivityUsers,
  getActivityLogs,
} from "../controllers/activityController.js";

const router = Router();

// any logged-in user — the app reports pages opened and logout
router.post("/view", recordPageView);
router.post("/logout", recordLogout);

// Activity page — Admin / SuperAdmin only
router.get("/users", authorize("Admin", "SuperAdmin"), getActivityUsers);
router.get("/logs", authorize("Admin", "SuperAdmin"), getActivityLogs);

export default router;
