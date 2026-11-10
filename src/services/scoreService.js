// Score, levels and badges ("game" layer on top of task completion).
//   Points for a completed task = the score (1–10) the assigner gives when approving it.
//   Levels come from the total points; achievement badges from the completed tasks.
import Task from "../models/Task.js";
import User from "../models/User.js";
import { deadlineOf } from "./taskNotificationService.js";

export const LEVELS = [
  { key: "rookie", name: "Rookie", min: 0, icon: "🌱" },
  { key: "bronze", name: "Bronze", min: 50, icon: "🥉" },
  { key: "silver", name: "Silver", min: 150, icon: "🥈" },
  { key: "gold", name: "Gold", min: 300, icon: "🥇" },
  { key: "platinum", name: "Platinum", min: 600, icon: "💠" },
  { key: "diamond", name: "Diamond", min: 1000, icon: "💎" },
  { key: "legend", name: "Legend", min: 2000, icon: "👑" },
];

export const BADGES = [
  { key: "first_win", name: "First Win", icon: "🎯", description: "Complete your first task" },
  { key: "task_hunter", name: "Task Hunter", icon: "⚔️", description: "Complete 10 tasks" },
  { key: "task_master", name: "Task Master", icon: "🏅", description: "Complete 50 tasks" },
  { key: "centurion", name: "Centurion", icon: "🏛️", description: "Complete 100 tasks" },
  { key: "challenge_crusher", name: "Challenge Crusher", icon: "🔥", description: "Complete a task with Complexity Score 80+" },
  { key: "flawless", name: "Flawless", icon: "✨", description: "10 tasks approved without any rework" },
  { key: "on_time", name: "Always On Time", icon: "⏰", description: "10 tasks completed before the deadline" },
  { key: "perfect_10", name: "Perfect 10", icon: "💯", description: "Get a 10/10 score on 5 tasks" },
  { key: "high_scorer", name: "High Scorer", icon: "⭐", description: "Reach 500 points" },
];

export const REVIEW_SCORE_MIN = 1;
export const REVIEW_SCORE_MAX = 10;

/** A valid review score (whole number 1–10) or null. */
export const parseReviewScore = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= REVIEW_SCORE_MIN && n <= REVIEW_SCORE_MAX ? n : null;
};

export const levelFor = (points = 0) => {
  let index = 0;
  LEVELS.forEach((l, i) => {
    if (points >= l.min) index = i;
  });
  const level = LEVELS[index];
  const next = LEVELS[index + 1] || null;
  const progress = next ? Math.round(((points - level.min) / (next.min - level.min)) * 100) : 100;
  return { ...level, next, progress, toNext: next ? next.min - points : 0 };
};

const earnedBadgeKeys = (completed, points) => {
  const onTime = completed.filter((t) => {
    const deadline = deadlineOf(t);
    return deadline && t.completedAt && new Date(t.completedAt) <= deadline;
  }).length;
  const keys = [];
  if (completed.length >= 1) keys.push("first_win");
  if (completed.length >= 10) keys.push("task_hunter");
  if (completed.length >= 50) keys.push("task_master");
  if (completed.length >= 100) keys.push("centurion");
  if (completed.some((t) => (t.complexity || 0) >= 80)) keys.push("challenge_crusher");
  if (completed.filter((t) => !t.reworkCount).length >= 10) keys.push("flawless");
  if (completed.filter((t) => t.reviewScore === 10).length >= 5) keys.push("perfect_10");
  if (onTime >= 10) keys.push("on_time");
  if (points >= 500) keys.push("high_scorer");
  return keys;
};

/** Full score card of one user: points, level, badges (earned + locked), stats. */
export const scoreProfile = async (userId, pointsOverride) => {
  const [user, completed] = await Promise.all([
    User.findById(userId).select("name points").lean(),
    Task.find({ assignedTo: userId, status: "Completed", isTaskBank: { $ne: true } })
      .select("complexity reward reviewScore reworkCount completedAt dueDate dueTime")
      .lean(),
  ]);
  const points = pointsOverride ?? user?.points ?? 0;
  const earned = new Set(earnedBadgeKeys(completed, points));
  return {
    userId: String(userId),
    name: user?.name || "",
    points,
    completed: completed.length,
    level: levelFor(points),
    badges: BADGES.map((b) => ({ ...b, earned: earned.has(b.key) })),
    earnedKeys: [...earned],
  };
};

/** Compare two profiles → what the "you win" screen should announce. */
export const celebrationFor = (before, after, earnedPoints) => ({
  earned: earnedPoints,
  score: after.points,
  level: { name: after.level.name, icon: after.level.icon, progress: after.level.progress, next: after.level.next?.name || null, toNext: after.level.toNext },
  levelUp: before.level.key !== after.level.key && after.points > before.points,
  newBadges: after.badges.filter((b) => b.earned && !before.earnedKeys.includes(b.key)).map(({ key, name, icon, description }) => ({ key, name, icon, description })),
});
