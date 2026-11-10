import { Router } from "express";

import {
  getReportSummary,
  exportReportCSV,
  saveReport,
  getSavedReports,
  getReportById,
  deleteSavedReport,
} from "../controllers/reportController.js";

import { requirePermission } from "../middleware/permissionMiddleware.js";
import { getIndividualReport } from "../controllers/individualReportController.js";

const router = Router();
const canView = requirePermission("reports", "view");

router.get("/summary", canView, getReportSummary);
router.get("/individual", canView, getIndividualReport);
router.get("/export", requirePermission("reports", "export"), exportReportCSV);
router.post("/save", canView, saveReport);
router.get("/history", canView, getSavedReports);
router.get("/history/:id", canView, getReportById);
router.delete("/history/:id", canView, deleteSavedReport);

export default router;
