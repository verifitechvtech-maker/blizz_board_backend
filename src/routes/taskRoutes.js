import express from "express";
import {
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  getTaskStats,
  saveToTaskBank,
  getTaskBank,
  assignFromBank,
  deleteFromBank,
  getTasksByGroup,        // ⭐ NEW — fetch sibling tasks of a multi-assign group
  uploadTaskAttachments,  // ⭐ multer middleware (field "attachments")
  uploadTaskFiles,        // ⭐ multer middleware for create/edit form (field "files")
  addTaskAttachments,     // ⭐ handler
  downloadTaskAttachment,
  uploadImportCSV,
  importTasks,
  getScoreboard,
  addSubtask,
  updateSubtask,
  deleteSubtask,
  getReferenceOptions,
  getEmployeeWorkload,
  getReworkIdPreview,
  updateChecklistItem,
  addTaskComment,
} from "../controllers/taskController.js";
import { getMonthlyProgress, updateMonthlyProgress } from "../controllers/monthlyTaskController.js";
import { requirePermission, requireAnyPermission } from "../middleware/permissionMiddleware.js";
import { emailTasksEnabled } from "../jobs/emailTaskInboxJob.js";
import { inboxAddress } from "../services/emailTaskService.js";

// ⭐⭐⭐ THIS MUST COME FIRST — before any router.<verb>() call
const router = express.Router();

const canView = requirePermission("tasks", "view");

// ==================== TASK BANK ROUTES (legacy isTaskBank tasks) ====================
router.get("/bank", requirePermission("taskbank", "view"), getTaskBank);
router.post("/bank", requirePermission("taskbank", "create"), saveToTaskBank);
router.patch("/bank/:id/assign", requirePermission("taskbank", "assign"), assignFromBank);
router.delete("/bank/:id", requirePermission("taskbank", "delete"), deleteFromBank);

// ==================== STATS ====================
router.get("/stats", canView, getTaskStats);
router.get("/scoreboard", getScoreboard); // own score + org leaderboard (any logged-in user)

// ==================== CSV IMPORT (Task Calendar) ====================
// CSV import — from the Tasks page (tasks.import) or the Task Calendar (calendar.import)
router.post("/import", requireAnyPermission(["tasks", "import"], ["calendar", "import"]), uploadImportCSV, importTasks);

// ==================== ATTACHMENT DOWNLOAD (authenticated + scoped) ====================
router.get("/attachments/:filename", canView, downloadTaskAttachment);

// ⭐⭐⭐ NEW — REGISTER BEFORE /:id
// Otherwise Express would treat "group" as an :id param and route it to
// getTaskById (which would then 404 because "group" isn't a valid ObjectId).
router.get("/group/:groupId", canView, getTasksByGroup);

// Create Task form helpers (also before /:id)
const canUseTaskForm = requireAnyPermission(["tasks", "create"], ["tasks", "edit"]);
router.get("/reference-options", canUseTaskForm, getReferenceOptions); // rework: pick the original task
router.get("/workload/:userId", canUseTaskForm, getEmployeeWorkload);   // assignee's live workload
router.get("/rework-id-preview", canUseTaskForm, getReworkIdPreview);   // TECH14-1 / TECH14-DEV1 per person

// Create-task-by-email: is it on, and which address do people send to?
router.get("/email-inbox", requirePermission("tasks", "create"), (req, res) =>
  res.json({ success: true, data: { enabled: emailTasksEnabled(), address: emailTasksEnabled() ? inboxAddress() : "" } })
);

// ==================== TASK CRUD ====================
router.get("/", canView, getTasks);
router.get("/:id", canView, getTaskById);
router.post("/", requirePermission("tasks", "create"), uploadTaskFiles, createTask);
router.patch("/:id", requirePermission("tasks", "edit"), uploadTaskFiles, updateTask);
router.put("/:id", requirePermission("tasks", "edit"), uploadTaskFiles, updateTask);
// Status changes are part of doing the work — assignees need only tasks.view
router.patch("/:id/status", canView, updateTaskStatus);
router.delete("/:id", requirePermission("tasks", "delete"), deleteTask);

// ==================== SUBTASKS ====================
// adding / moving / removing is checked in the controller (assigner, Manager, Admin);
// the assignee can tick their own subtasks
router.post("/:id/subtasks", canView, uploadTaskAttachments, addSubtask);
router.patch("/:id/subtasks/:subId", canView, uploadTaskAttachments, updateSubtask);
router.delete("/:id/subtasks/:subId", canView, deleteSubtask);

// ==================== COMMENTS (assignee ↔ assigner) ====================
router.post("/:id/comments", canView, addTaskComment);

// ==================== CHECKLIST ====================
// tick / answer a row — assignee, the row's employee or the task's creator (checked in the controller)
router.patch("/:id/checklist/:itemId", canView, updateChecklistItem);

// ==================== MONTHLY TASK — DAILY PROGRESS ====================
// anyone who can see the task reads it; only its assignee writes (checked in the controller)
router.get("/:id/monthly", canView, getMonthlyProgress);
router.put("/:id/monthly/:date", canView, updateMonthlyProgress);

// ==================== ATTACHMENTS ====================
router.post("/:id/attachments", canView, uploadTaskAttachments, addTaskAttachments);

export default router;
