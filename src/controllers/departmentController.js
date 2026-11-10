import mongoose from "mongoose";
import Department from "../models/Department.js";

const validateObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// ⭐⭐⭐ Helper — build the isolation filter for departments
// SuperAdmin → all | Admin → his own | User → his admin's ACTIVE only (read-only)
const deptFilter = (req) => {
  if (req.user.role === "SuperAdmin") return {};
  if (req.user.role === "Admin") return { admin_id: req.adminId };
  return { admin_id: req.adminId, status: "Active" };
};

// ==================== CREATE DEPARTMENT ====================
export const createDepartment = async (req, res) => {
  try {
    // ⭐ only Admin/SuperAdmin can create
    if (req.user.role === "User") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Only Admin can create departments.",
      });
    }

    const { name, description, status } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Department name is required",
      });
    }

    // ⭐ duplicate check within OWN org only (admin1 "Sales" ≠ admin2 "Sales")
    const query = { name: name.trim(), admin_id: req.adminId };

    const existing = await Department.findOne(query);
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Department already exists",
      });
    }

    const department = await Department.create({
      name: name.trim(),
      description: description || "",
      status: status || "Active",
      createdBy: req.user.id,          // keep — who created it
      admin_id: req.adminId,           // ⭐⭐⭐ ISOLATION KEY — from token
    });

    return res.status(201).json({
      success: true,
      message: "Department created successfully",
      data: department,
    });
  } catch (error) {
    console.error("Create Department Error:", error);

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Department name already exists",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== GET ALL DEPARTMENTS (ISOLATED) ====================
export const getAllDepartments = async (req, res) => {
  try {
    // ⭐⭐⭐ one filter for all roles:
    // SuperAdmin → all | Admin1 → his only (NOT admin2's) | User → his admin's active
    const departments = await Department.find(deptFilter(req)).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Departments fetched successfully",
      count: departments.length,
      data: departments,
    });
  } catch (error) {
    console.error("Get Departments Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== GET SINGLE DEPARTMENT ====================
export const getDepartmentById = async (req, res) => {
  try {
    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid department ID format",
      });
    }

    // ⭐⭐⭐ ID-PROOF — scope included (admin2/user from other org → not found)
    const department = await Department.findOne({
      _id: req.params.id,
      ...deptFilter(req),
    });

    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Department fetched successfully",
      data: department,
    });
  } catch (error) {
    console.error("Get Department Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== UPDATE DEPARTMENT ====================
export const updateDepartment = async (req, res) => {
  try {
    // ⭐ Users can NEVER update departments
    if (req.user.role === "User") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Only Admin can update departments.",
      });
    }

    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid department ID format",
      });
    }

    // ⭐⭐⭐ ID-PROOF — admin2 can't update admin1's department
    const existing = await Department.findOne({
      _id: req.params.id,
      admin_id: req.adminId,
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    const { name, description, status } = req.body;

    const updateFields = {};
    if (name) updateFields.name = name.trim();
    if (description !== undefined) updateFields.description = description;
    if (status) updateFields.status = status;

    const updatedDept = await Department.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: "Department updated successfully",
      data: updatedDept,
    });
  } catch (error) {
    console.error("Update Department Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ==================== DELETE DEPARTMENT ====================
export const deleteDepartment = async (req, res) => {
  try {
    // ⭐ Users can NEVER delete departments
    if (req.user.role === "User") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Only Admin can delete departments.",
      });
    }

    if (!validateObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid department ID format",
      });
    }

    // ⭐⭐⭐ ID-PROOF — scoped delete
    const department = await Department.findOneAndDelete({
      _id: req.params.id,
      admin_id: req.adminId,
    });

    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Department deleted successfully",
    });
  } catch (error) {
    console.error("Delete Department Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};