import cron from "node-cron";
import { runChosenReminderSweep, runTaskReminderSweep, TASK_TIME_ZONE } from "../services/taskNotificationService.js";

// Every minute: 3h reminder, 1h reminder, deadline alert (only for tasks still "To Do")
export const startTaskReminderJob = () => {
  let running = false;
  cron.schedule("* * * * *", async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const counts = await runTaskReminderSweep();
      counts.chosen = await runChosenReminderSweep(); // the reminder picked in the task form
      const total = counts.reminder3h + counts.reminder1h + counts.overdue + counts.chosen;
      if (total) console.log("Task reminders sent:", counts);
    } catch (error) {
      console.error("Task reminder job failed:", error.message);
    } finally {
      running = false;
    }
  });
  console.log(`Task reminder job started (3h / 1h before deadline + deadline alert, ${TASK_TIME_ZONE})`);
};
