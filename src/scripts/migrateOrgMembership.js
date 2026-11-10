// One-time data fix: link legacy member accounts / departments to their organization.
// Users created before admin_id existed only have createdBy = <Admin _id>, so their
// tasks, calendar and departments were invisible to them.
//
//   npm run migrate:org            (dry run — prints what would change)
//   npm run migrate:org -- --apply (writes the changes)
import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";
import Department from "../models/Department.js";

dotenv.config();

const apply = process.argv.includes("--apply");

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const adminIds = (await User.find({ role: "Admin" }).select("_id").lean()).map((a) => a._id);

  const users = await User.find({
    role: { $in: ["Manager", "User"] },
    admin_id: null,
    createdBy: { $in: adminIds },
  }).select("name email createdBy").lean();

  const depts = await Department.find({ admin_id: null, createdBy: { $in: adminIds } })
    .select("name createdBy").lean();

  console.log(`${users.length} member account(s) and ${depts.length} department(s) without admin_id`);
  users.forEach((u) => console.log(`  user  ${u.email} → org ${u.createdBy}`));
  depts.forEach((d) => console.log(`  dept  ${d.name} → org ${d.createdBy}`));

  if (apply) {
    for (const u of users) await User.updateOne({ _id: u._id }, { admin_id: u.createdBy });
    for (const d of depts) await Department.updateOne({ _id: d._id }, { admin_id: d.createdBy });
    console.log("✅ Applied");
  } else {
    console.log("Dry run only — re-run with --apply to write changes");
  }
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});
