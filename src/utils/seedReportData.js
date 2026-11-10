import mongoose from "mongoose";
import dotenv from "dotenv";
import Task from "../models/Task"; // ⚠️ uses YOUR Task model

dotenv.config();

// ============================================================
// CONFIG — adjust to match your real data if needed
// ============================================================

// Department names + counts match your frontend exactly
// (Management 42, Development 68, Marketing 37, Finance 31, HR 24)
const DEPARTMENTS = [
  { name: "Management",      early: 10, onTime: 12, late: 6,  review: 3, progress: 2, pending: 4, overdue: 5 },
  { name: "Development",     early: 16, onTime: 19, late: 11, review: 5, progress: 4, pending: 7, overdue: 6 },
  { name: "Marketing",       early: 8,  onTime: 11, late: 6,  review: 3, progress: 2, pending: 3, overdue: 4 },
  { name: "Finance",         early: 7,  onTime: 9,  late: 5,  review: 2, progress: 3, pending: 2, overdue: 3 },
  { name: "Human Resources", early: 5,  onTime: 8,  late: 5,  review: 2, progress: 1, pending: 2, overdue: 2 },
];

// ~34% High, 46% Medium, 20% Low → matches your donut chart
const PRIORITY_PATTERN = [
  ...Array(34).fill("High"),
  ...Array(46).fill("Medium"),
  ...Array(20).fill("Low"),
];

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();

// Spread createdAt across the last 90 days so the
// "Today / This week / This month / This quarter" filters show different numbers
const randomDateInRange = (maxDaysBack) => {
  const daysBack = Math.floor(Math.random() * maxDaysBack);
  const d = new Date(now.getTime() - daysBack * DAY_MS);
  d.setHours(Math.floor(Math.random() * 10) + 8, Math.floor(Math.random() * 60), 0, 0);
  return d;
};

const seed = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is not defined in .env");
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // ---------- SAFETY CHECK ----------
    const force = process.argv.includes("--force");
    const existingCount = await Task.countDocuments();

    if (existingCount > 0) {
      if (!force) {
        console.log(`⚠️  Task collection is NOT empty (${existingCount} tasks found).`);
        console.log("   Seeding stopped to protect your real data.");
        console.log("   To wipe and reseed, run:  node seedReportData.js --force\n");
        await mongoose.connection.close();
        return;
      }
      await Task.deleteMany({});
      console.log(`🗑️  Deleted ${existingCount} existing tasks (--force)\n`);
    }

    // ---------- BUILD TASKS ----------
    const tasks = [];
    let ref = 1;
    let priorityIndex = 0;

    const nextPriority = () =>
      PRIORITY_PATTERN[priorityIndex++ % PRIORITY_PATTERN.length];

    const buildTask = (dept, status, completionType = null) => {
      const createdAt = randomDateInRange(90);

      let dueDate = new Date(
        createdAt.getTime() + (Math.floor(Math.random() * 10) + 3) * DAY_MS
      );

      let completedAt = null;
      if (status === "Completed") {
        completedAt = new Date(dueDate);
        if (completionType === "Early") {
          completedAt = new Date(dueDate.getTime() - 2 * DAY_MS);
        }
        if (completionType === "Late") {
          completedAt = new Date(dueDate.getTime() + 2 * DAY_MS);
        }
      }

      // Overdue tasks must actually be past their due date
      if (status === "Overdue") {
        dueDate = new Date(now.getTime() - (Math.floor(Math.random() * 5) + 1) * DAY_MS);
      }

      return {
        referenceId: `REF-${String(ref++).padStart(3, "0")}`,
        title: `${dept.name} — sample task ${ref}`,
        description: "Seeded demo task for reports",
        department: dept.name,       // ⚠️ must match your Task schema field
        priority: nextPriority(),    // ⚠️ High / Medium / Low
        status,                      // ⚠️ must match your Task schema enum
        completionType,              // ⚠️ Early / On Time / Late / null
        startDate: createdAt,
        createdAt,
        updatedAt: createdAt,
        dueDate,
        completedAt,
      };
    };

    for (const dept of DEPARTMENTS) {
      const add = (count, status, type = null) => {
        for (let i = 0; i < count; i++) tasks.push(buildTask(dept, status, type));
      };

      add(dept.early,    "Completed",  "Early");
      add(dept.onTime,   "Completed",  "On Time");
      add(dept.late,     "Completed",  "Late");
      add(dept.review,   "Review");
      add(dept.progress, "In Progress");
      add(dept.pending,  "Pending");
      add(dept.overdue,  "Overdue");
    }

    // ---------- INSERT ----------
    // timestamps:false → we control createdAt manually (needed for date filters)
    await Task.insertMany(tasks, { timestamps: false });

    console.log(`✅ Seeded ${tasks.length} tasks across ${DEPARTMENTS.length} departments\n`);

    // ---------- SUMMARY ----------
    console.log("Seeded per department:");
    DEPARTMENTS.forEach((d) => {
      const total =
        d.early + d.onTime + d.late + d.review + d.progress + d.pending + d.overdue;
      console.log(`   ${d.name.padEnd(18)} ${total} tasks`);
    });

    console.log("\nNext step: test in Postman →");
    console.log("GET http://localhost:5000/api/reports/summary?dateRange=All%20time");

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Seeding failed:", error.message);

    if (error.name === "ValidationError") {
      console.error("\n👉 Your Task model has different required fields or enum values.");
      console.error("   Look at the field listed in the error above, then fix buildTask()");
      console.error("   OR paste your models/Task.js so I can match it exactly.");
    }

    await mongoose.connection.close();
    process.exit(1);
  }
};

seed();