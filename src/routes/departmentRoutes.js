import express from "express";
import mongoose from "mongoose";
import Department from "../models/Department.js";
import { authenticate } from "../middleware/authMiddleware.js"; // ✅ correct name
import { requirePermission } from "../middleware/permissionMiddleware.js";
import { ensurePrefix, highestUsedNumber, normalizePrefix, suggestPrefix, takenPrefixes } from "../services/referenceIdService.js";

const router = express.Router();

// what the forms show: code + the next reference ID a new task would get
const shapeDepartment = (d) => {
  const doc = d.toObject ? d.toObject() : d;
  return { ...doc, nextReferenceId: doc.refPrefix ? `${doc.refPrefix}${(doc.taskSeq || 0) + 1}` : null };
};

// ⭐ Organization filter — departments belong to an Admin's org.
// Older records only have createdBy (the Admin), newer ones also have admin_id.
const orgFilter = (req) => {
  if (req.user.role === "SuperAdmin") {
    const adminId = req.query.adminId || req.body?.adminId;
    return mongoose.Types.ObjectId.isValid(adminId)
      ? { $or: [{ admin_id: adminId }, { createdBy: adminId }] }
      : {};
  }
  return { $or: [{ admin_id: req.adminId }, { createdBy: req.adminId }] };
};

// CREATE
router.post("/", authenticate, requirePermission("users", "create"), async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Department name is required" });
    }

    const exists = await Department.findOne({
      ...orgFilter(req),
      name: { $regex: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
    });
    if (exists) {
      return res.status(409).json({ success: false, message: "Department already exists" });
    }

    const orgId =
      req.user.role === "SuperAdmin"
        ? (mongoose.Types.ObjectId.isValid(req.body.adminId) ? req.body.adminId : null)
        : req.adminId;

    // Reference code for task IDs (FF → FF1, FF2…): given, or made from the name
    const taken = orgId ? await takenPrefixes(orgId) : new Set();
    let refPrefix;
    if (req.body.refPrefix !== undefined && String(req.body.refPrefix).trim() !== "") {
      const parsed = normalizePrefix(req.body.refPrefix);
      if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
      if (taken.has(parsed.prefix)) {
        return res.status(409).json({ success: false, message: `Reference code "${parsed.prefix}" is already used by another department` });
      }
      refPrefix = parsed.prefix;
    } else {
      refPrefix = suggestPrefix(name, taken);
    }

    const dept = await Department.create({
      name: name.trim(),
      description: description?.trim() || "",
      refPrefix,
      createdBy: req.user._id,
      admin_id: orgId,                 // ⭐ org key from the token, never the body (except SuperAdmin)
    });

    res.status(201).json({ success: true, data: shapeDepartment(dept) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// READ — the organization's departments (every member needs these for task forms)
router.get("/", authenticate, async (req, res) => {
  try {
    const departments = await Department.find(orgFilter(req)).sort({ createdAt: 1 });
    // older departments get their reference code the first time they are listed
    for (const d of departments) {
      if (!d.refPrefix) d.refPrefix = await ensurePrefix(d);
    }
    res.json({ success: true, data: departments.map(shapeDepartment) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// UPDATE the reference code (new tasks use it; existing task IDs stay as they are)
router.patch("/:id", authenticate, requirePermission("users", "edit"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid department ID" });
    }
    const dept = await Department.findOne({ _id: req.params.id, ...orgFilter(req) });
    if (!dept) return res.status(404).json({ success: false, message: "Department not found" });

    if (req.body.refPrefix !== undefined) {
      const parsed = normalizePrefix(req.body.refPrefix);
      if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
      const taken = await takenPrefixes(dept.admin_id || dept.createdBy, dept._id);
      if (taken.has(parsed.prefix)) {
        return res.status(409).json({ success: false, message: `Reference code "${parsed.prefix}" is already used by another department` });
      }
      // a new code continues after the highest number ever used with it (IDs never repeat);
      // the old code's IDs stay on their tasks
      if (parsed.prefix !== dept.refPrefix) {
        dept.taskSeq = await highestUsedNumber(dept.admin_id || dept.createdBy, parsed.prefix);
      }
      dept.refPrefix = parsed.prefix;
    }
    if (req.body.description !== undefined) dept.description = String(req.body.description).trim();

    await dept.save();
    res.json({ success: true, data: shapeDepartment(dept) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE
router.delete("/:id", authenticate, requirePermission("users", "delete"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid department ID" });
    }
    const dept = await Department.findOneAndDelete({
      _id: req.params.id,
      ...orgFilter(req),
    });
    if (!dept) return res.status(404).json({ success: false, message: "Department not found" });
    res.json({ success: true, message: "Department deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
