
import cron from "node-cron";
import Meeting from "../models/Meeting.js";
import { sendMeetingReminder } from "../services/meetingEmailService.js";
import { getMeetingStartDate } from "../services/googleCalendarService.js";
import { telegramMeetingNotice } from "../services/telegram/telegramNotify.js";

const reminderMinutes = Number(
  process.env.MEETING_REMINDER_MINUTES || 15
);

export const startMeetingReminderJob = () => {
  cron.schedule("* * * * *", async () => {
    try {
      const now = new Date();
      const reminderWindowEnd = new Date(
        now.getTime() + reminderMinutes * 60 * 1000
      );

      // meetingDate is the DAY; the exact start = day + startTime (meeting time zone)
      const DAY = 24 * 60 * 60 * 1000;
      const candidates = await Meeting.find({
        status: "Scheduled",
        reminderSentAt: null,
        meetingDate: {
          $gte: new Date(now.getTime() - DAY),
          $lte: new Date(reminderWindowEnd.getTime() + DAY),
        },
      });

      const meetings = candidates.filter((meeting) => {
        try {
          const start = getMeetingStartDate(meeting).toJSDate();
          return start >= now && start <= reminderWindowEnd;
        } catch {
          return false;
        }
      });

      for (const meeting of meetings) {
        // Telegram: once per start time, even while the email keeps retrying
        const key = `${new Date(meeting.meetingDate).toISOString().slice(0, 10)}|${meeting.startTime || ""}`;
        const claimed = await Meeting.updateOne(
          { _id: meeting._id, telegramReminderFor: { $ne: key } },
          { $set: { telegramReminderFor: key } }
        );
        if (claimed.modifiedCount) {
          telegramMeetingNotice(meeting, "reminder").catch((err) => console.error("[telegram]", err.message));
        }

        const result = await sendMeetingReminder(meeting, { auto: true });

        if (result.sent) {
          meeting.reminderSentAt = new Date();
          await meeting.save();

          console.log(
            `Reminder sent for meeting: ${meeting.title}`
          );
        } else {
          console.warn(
            `Reminder not sent for "${meeting.title}": ${result.reason}`
          );
        }
      }
    } catch (error) {
      console.error("Meeting reminder job failed:", error.message);
    }
  });

  console.log(
    `Meeting reminder job started (${reminderMinutes} minutes before meetings)`
  );
};
