import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

import authRoutes from "./routes/authRoutes.js";
import taskEmailRoutes from "./routes/taskEmailRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import departmentRoutes from "./routes/departmentRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";
import taskBankRoutes from "./routes/taskBankRoutes.js";
import taskCalendarRoutes from "./routes/taskCalendar.js";
import meetingRoutes from "./routes/MeetingRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import supportRoutes from "./routes/supportRoutes.js";
import permissionRoutes from "./routes/permissionRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import pushRoutes from "./routes/pushRoutes.js";
import customRoleRoutes from "./routes/customRoleRoutes.js";
import telegramRoutes from "./routes/telegramRoutes.js";
import activityRoutes from "./routes/activityRoutes.js";
import { trackActivity } from "./services/activityService.js";
import { getConnectUrl, oauthCallback } from "./controllers/googleConnectController.js";
import { authorize } from "./middleware/role.js";

import { authenticate } from "./middleware/auth.js";
import { attachScope } from "./middleware/scopeMiddleware.js";
import { attachOrgUsers } from "./middleware/orgScope.js";
import { attachPermissions, permissionByMethod, requirePermission } from "./middleware/permissionMiddleware.js";
import { registerChatSocket } from "./socket/Chatsocket.js";
import { setRealtimeIO } from "./socket/realtime.js";
import { registerMeetingSocket } from "./socket/meetingSocket.js";
import { PRODUCTION_FRONTEND_URL } from "./config/urls.js";

dotenv.config();

export const app = express();
export const server = http.createServer(app);

// Render (and most hosts) put a proxy in front: trust it so req.ip / https are the real ones
app.set("trust proxy", 1);

// ⭐ Required for ESM — used to resolve the uploads directory path
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Frontends allowed to call this API: FRONTEND_URL + CORS_ORIGINS (comma separated) from .env,
// plus the local dev servers.
const allowedOrigins = [
  ...new Set(
    [
      process.env.FRONTEND_URL,
      PRODUCTION_FRONTEND_URL, // https://blizz-board-frontend.vercel.app
      ...String(process.env.CORS_ORIGINS || "").split(","),
      "http://localhost:3000",
      "http://localhost:5173",
    ]
      .map((o) => String(o || "").trim().replace(/\/+$/, ""))
      .filter(Boolean)
  ),
];

// ==================== SOCKET.IO ====================
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

registerChatSocket(io);
registerMeetingSocket(io); // WebRTC signaling for MoM video calls
app.set("io", io);
setRealtimeIO(io); // real-time notifications (task assigned, status changes, tickets…)

// ==================== MIDDLEWARE ====================
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json({ limit: "3mb" }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));

// 🔒 Task attachments are NOT served statically any more (that made every file public).
// Download them through the authenticated, scope-checked endpoint:
//   GET /api/tasks/attachments/:filename

// ==================== PUBLIC ROUTES ====================
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Task Management API is running",
    version: "1.0.0",
    endpoints: {
      auth: "/api/auth",
      users: "/api/users",
      departments: "/api/departments",
      tasks: "/api/tasks",
      taskbank: "/api/taskbank",
      taskcalendar: "/api/taskcalendar",
      meetings: "/api/meetings",
      chat: "/api/chat",
      reports: "/api/reports",
      support: "/api/support",
      permissions: "/api/permissions",
    },
  });
});

app.use("/api/auth", authRoutes);
// Public: task page opened from the assignment email (signed link, no login)
app.use("/api/task-email", taskEmailRoutes);

// Google reconnect: Google sends the browser back here (must match GOOGLE_REDIRECT_URI)
app.get("/oauth2callback", oauthCallback);

// ==================== PROTECTED ROUTES ====================
// Every protected request: authenticate → data scope → effective permissions
const protect = [authenticate, attachScope, attachPermissions, trackActivity];

// Activity: pages opened / logout (everyone); Activity page (Admin / SuperAdmin)
app.use("/api/activity", ...protect, activityRoutes);

app.use("/api/permissions", ...protect, permissionRoutes);
app.use("/api/notifications", ...protect, notificationRoutes);
app.use("/api/push", ...protect, pushRoutes);
app.use("/api/custom-roles", ...protect, customRoleRoutes);
// Telegram bot: connect / disconnect my account (any logged-in user)
app.use("/api/telegram", ...protect, telegramRoutes);
app.post("/api/google/connect-url", ...protect, authorize("Admin", "SuperAdmin"), getConnectUrl);
app.use("/api/departments", ...protect, departmentRoutes);
app.use("/api/tasks", ...protect, taskRoutes);
app.use("/api/taskbank", ...protect, taskBankRoutes);
app.use("/api/taskcalendar", ...protect, taskCalendarRoutes);
// MoM + chat — module gate only; the MoM/chat controllers are unchanged
app.use("/api/meetings", ...protect, attachOrgUsers, permissionByMethod("communication"), meetingRoutes);
app.use("/api/chat", ...protect, requirePermission("chat", "view"), chatRoutes);
app.use("/api/support", ...protect, permissionByMethod("support"), supportRoutes);
app.use("/api/reports", ...protect, reportRoutes);

// Keep the general user route last.
app.use("/api", ...protect, userRoutes);

// ==================== 404 ====================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ==================== GLOBAL ERROR ====================
app.use((err, req, res, next) => {
  console.error("Global Error:", err);

  if (res.headersSent) {
    return next(err);
  }

  // Malformed JSON bodies etc. carry their own 4xx status
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    message: status < 500 ? err.message : "Something went wrong",
    error:
      process.env.NODE_ENV === "production" ? undefined : err.message,
  });
});

export default app;
