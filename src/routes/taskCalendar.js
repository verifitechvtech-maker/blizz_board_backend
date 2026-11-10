import express from "express";
import multer from "multer";
import { permissionByMethod, requirePermission } from "../middleware/permissionMiddleware.js";
import {
  getTasks,
  createTask,
  importTasks,
  updateTask,
  deleteTask,
} from "../controllers/taskCalendarController.js";

const router = express.Router();

// Authentication + scope are applied where this router is mounted (server/app.js).
// ⚠️ Do NOT re-verify the JWT here — that used to replace req.user (the full DB user)
// with the raw token payload, so req.user._id was undefined in every handler.

// ==================== CSV UPLOAD CONFIG ====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith(".csv")) return cb(null, true);
    cb(new Error("Only .csv files allowed."));
  },
});

// ==================== ROUTES ====================
const byMethod = permissionByMethod("calendar");

router.get("/", byMethod, getTasks);                              // calendar daily work
router.post("/", byMethod, createTask);                           // add task
router.post("/import", requirePermission("calendar", "import"), upload.single("file"), importTasks); // CSV import ⭐
router.put("/:id", byMethod, updateTask);                         // edit task
router.delete("/:id", byMethod, deleteTask);                      // delete task

export default router;