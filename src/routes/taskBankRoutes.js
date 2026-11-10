import express from "express";
import { authenticate, authorize } from "../middleware/authMiddleware.js";
import { requirePermission } from "../middleware/permissionMiddleware.js";
import {
  getItems,
  getStats,
  seed,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  duplicateItem,
  assignItem,
  reassignItem,
  uploadBankCSV,
  importItems,
  downloadBankAttachment,
} from "../controllers/taskBankController.js";
import { uploadTaskFiles } from "../controllers/taskController.js";

const router = express.Router();

// 🔒 ALL ROUTES REQUIRE A VALID TOKEN
router.use(authenticate);

// Sample global templates — SuperAdmin only (was public)
router.get("/seed", authorize("SuperAdmin"), seed);
router.post("/seed", authorize("SuperAdmin"), seed);

router.get("/", requirePermission("taskbank", "view"), getItems);
router.post("/import", requirePermission("taskbank", "import"), uploadBankCSV, importItems);
router.get("/stats", requirePermission("taskbank", "view"), getStats);
router.get("/:id", requirePermission("taskbank", "view"), getItem);
// multipart field "files" (same rules as task attachments: type list, 10 MB each, up to 10)
router.post("/", requirePermission("taskbank", "create"), uploadTaskFiles, createItem);
router.get("/:id/attachments/:filename", requirePermission("taskbank", "view"), downloadBankAttachment);
router.post("/:id/duplicate", requirePermission("taskbank", "create"), duplicateItem);
router.post("/:id/assign", requirePermission("taskbank", "assign"), assignItem);
router.post("/:id/reassign", requirePermission("taskbank", "assign"), reassignItem);
router.put("/:id", requirePermission("taskbank", "edit"), uploadTaskFiles, updateItem);
router.delete("/:id", requirePermission("taskbank", "delete"), deleteItem);

export default router;
