import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";

dotenv.config();

const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected");

    // Check if SuperAdmin already exists
    const existing = await User.findOne({ role: "SuperAdmin" });

    if (existing) {
      console.log("⚠️  SuperAdmin already exists:");
      console.log(`   Email: ${existing.email}`);
      console.log(`   ID: ${existing._id}`);
      process.exit(0);
    }

    // Create SuperAdmin — login details come from .env, never from the code
    const email = String(process.env.SUPERADMIN_EMAIL || "").trim().toLowerCase();
    const password = String(process.env.SUPERADMIN_PASSWORD || "");
    if (!email || password.length < 8) {
      console.error("❌ Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (8+ characters) in .env first");
      process.exit(1);
    }

    const superAdmin = await User.create({
      name: "Super Admin",
      email,
      password,
      phone: "9999999999",
      role: "SuperAdmin",
      status: "Active",
      createdBy: null,
    });

    console.log("✅ SuperAdmin created successfully!");
    console.log(`   Name:     ${superAdmin.name}`);
    console.log(`   Email:    ${superAdmin.email}`);
    console.log("   Password: (the SUPERADMIN_PASSWORD from .env)");
    console.log(`   ID:       ${superAdmin._id}`);
    console.log("\n⚠️  Change the password after first login!");

    process.exit(0);
  } catch (error) {
    console.error("❌ Seed Error:", error.message);
    process.exit(1);
  }
};

seedSuperAdmin();