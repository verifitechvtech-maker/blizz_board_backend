// Public (token in the URL) — task page opened from the assignment email
import express from "express";
import {
  getEmailTask,
  markEmailTaskViewed,
  updateEmailTaskStatus,
} from "../controllers/taskEmailActionController.js";

const router = express.Router();

router.get("/:token", getEmailTask);
router.post("/:token/view", markEmailTaskViewed);
router.post("/:token/status", updateEmailTaskStatus);

export default router;
