// // ======================================================
// //  ROLE ACCESS CONFIGURATION
// // ======================================================
// import {
//   ClipboardCheck,
//   Database,
//   CalendarDays,
//   FileText,
//   MessageCircle,
//   Users,
//   BarChart3,
// } from "lucide-react";

// // ---------- ALL MODULES ----------
// export const MODULES = [
//   { id: "tasks",    label: "Tasks",     path: "/tasks",     icon: ClipboardCheck },
//   { id: "taskbank", label: "Task Bank", path: "/task-bank", icon: Database },
//   { id: "calendar", label: "Calendar",  path: "/calendar",  icon: CalendarDays },
//   { id: "mom",      label: "MOM",       path: "/mom",       icon: FileText },
//   { id: "chat",     label: "Chat",      path: "/chat",      icon: MessageCircle },
//   { id: "users",    label: "Users",     path: "/users",     icon: Users },
//   { id: "reports",  label: "Reports",   path: "/reports",   icon: BarChart3 },
// ];

// // ---------- PERMISSION GROUPS ----------
// export const PERMISSION_GROUPS = [
//   {
//     id: "tasks",
//     title: "Tasks Management",
//     icon: ClipboardCheck,
//     description: "Manage tasks and assignments",
//     permissions: ["Create Tasks", "View Tasks", "Edit Tasks", "Delete Tasks", "Assign Tasks"],
//   },
//   {
//     id: "taskbank",
//     title: "Task Bank",
//     icon: Database,
//     description: "Manage reusable task templates",
//     permissions: ["Create Templates", "View Templates", "Edit Templates", "Delete Templates", "Import Templates"],
//   },
//   {
//     id: "calendar",
//     title: "Calendar",
//     icon: CalendarDays,
//     description: "Manage calendars and schedules",
//     permissions: ["View Calendar", "Create Events", "Edit Events", "Delete Events", "Manage Calendar"],
//   },
//   {
//     id: "mom",
//     title: "MOM",
//     icon: FileText,
//     description: "Minutes of meeting",
//     permissions: ["View MOM", "Create MOM", "Edit MOM", "Delete MOM"],
//   },
//   {
//     id: "chat",
//     title: "Chat",
//     icon: MessageCircle,
//     description: "Communication and collaboration",
//     permissions: ["View Chats", "Send Messages", "Create Groups", "Manage Groups", "Delete Messages"],
//   },
//   {
//     id: "users",
//     title: "User Management",
//     icon: Users,
//     description: "Manage organization users",
//     permissions: ["Create Users", "View Users", "Edit Users", "Delete Users", "Assign Roles"],
//   },
//   {
//     id: "reports",
//     title: "Reports & Analytics",
//     icon: BarChart3,
//     description: "View organization reports",
//     permissions: ["View Reports", "Export Reports", "View Analytics", "Create Reports", "Manage Reports"],
//   },
// ];

// // ---------- STARTING DEFAULTS ----------
// // "ALL" = everything ON | [array] = only these ON | [] = module HIDDEN
// export const DEFAULT_ROLE_ACCESS = {
//   Admin: {
//     tasks: "ALL",
//     taskbank: "ALL",
//     calendar: "ALL",
//     mom: "ALL",
//     chat: "ALL",
//     users: "ALL",
//     reports: "ALL",
//   },
//   Manager: {
//     tasks:    ["View Tasks", "Create Tasks", "Edit Tasks", "Delete Tasks", "Assign Tasks"],
//     taskbank: ["View Templates", "Create Templates", "Edit Templates", "Delete Templates", "Import Templates"],
//     calendar: ["View Calendar", "Create Events", "Edit Events", "Delete Events", "Manage Calendar"],
//     mom:      ["View MOM", "Create MOM", "Edit MOM", "Delete MOM"],
//     chat:     ["View Chats", "Send Messages", "Create Groups", "Manage Groups", "Delete Messages"],
//     users:    [],
//     reports:  [],
//   },
//   TL: {
//     tasks:    ["View Tasks", "Create Tasks", "Edit Tasks", "Assign Tasks"],
//     taskbank: ["View Templates", "Create Templates", "Import Templates"],
//     calendar: ["View Calendar", "Create Events", "Edit Events"],
//     mom:      ["View MOM", "Create MOM", "Edit MOM"],
//     chat:     ["View Chats", "Send Messages", "Create Groups"],
//     users:    [],
//     reports:  [],
//   },
//   User: {
//     tasks:    ["View Tasks", "Edit Tasks"],
//     taskbank: ["View Templates"],
//     calendar: ["View Calendar"],
//     mom:      ["View MOM"],
//     chat:     ["View Chats", "Send Messages"],
//     users:    [],
//     reports:  [],
//   },
// };

// // ---------- STORAGE ----------
// const STORAGE_KEY = "role_access_config";

// export const getAccessConfig = () => {
//   try {
//     const raw = localStorage.getItem(STORAGE_KEY);
//     if (raw) return JSON.parse(raw);
//   } catch (e) {
//     /* ignore */
//   }
//   return JSON.parse(JSON.stringify(DEFAULT_ROLE_ACCESS));
// };

// export const saveAccessConfig = (config) => {
//   localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
//   window.dispatchEvent(new Event("roleAccessChanged"));
// };

// export const resetAccessConfig = () => {
//   localStorage.removeItem(STORAGE_KEY);
//   window.dispatchEvent(new Event("roleAccessChanged"));
// };

// // ---------- CURRENT USER ROLE ----------
// // Login must save: localStorage.setItem("user", JSON.stringify({ name, role }))
// export const getCurrentUserRole = () => {
//   try {
//     const raw = localStorage.getItem("user");
//     const user = raw ? JSON.parse(raw) : null;
//     return user?.role || "User";
//   } catch (e) {
//     return "User";
//   }
// };

// // ---------- HELPERS ----------
// const resolveRole = (roleName) => {
//   const name = String(roleName || "").toLowerCase();
//   return Object.keys(DEFAULT_ROLE_ACCESS).find(
//     (k) => k.toLowerCase() === name
//   );
// };

// export const getRoleAccess = (roleName) => {
//   const role = resolveRole(roleName);
//   const config = getAccessConfig();
//   return role ? config[role] || {} : {};
// };

// // Module shows in nav if AT LEAST 1 permission is ON
// export const hasModuleAccess = (roleName, moduleId) => {
//   const allowed = getRoleAccess(roleName)[moduleId];
//   return allowed === "ALL" || (Array.isArray(allowed) && allowed.length > 0);
// };

// export const hasPermission = (roleName, moduleId, permission) => {
//   const allowed = getRoleAccess(roleName)[moduleId];
//   return (
//     allowed === "ALL" ||
//     (Array.isArray(allowed) && allowed.includes(permission))
//   );
// };

// export const getNavForRole = (roleName) =>
//   MODULES.filter((m) => hasModuleAccess(roleName, m.id));

// // Build toggle states from SAVED access
// export const buildPermissionState = (roleName) => {
//   return buildStateFromAccess(getRoleAccess(roleName));
// };

// // Build toggle states from ORIGINAL defaults (for Load defaults button)
// export const getDefaultPermissionState = (roleName) => {
//   const role = resolveRole(roleName);
//   return buildStateFromAccess(role ? DEFAULT_ROLE_ACCESS[role] : {});
// };

// const buildStateFromAccess = (access = {}) => {
//   const state = {};
//   PERMISSION_GROUPS.forEach((group) => {
//     const allowed = access[group.id];
//     group.permissions.forEach((permission) => {
//       state[`${group.id}.${permission}`] =
//         allowed === "ALL" ||
//         (Array.isArray(allowed) && allowed.includes(permission));
//     });
//   });
//   return state;
// };

// // Convert toggle screen back into saveable access object
// export const permissionStateToAccess = (state) => {
//   const access = {};
//   PERMISSION_GROUPS.forEach((group) => {
//     access[group.id] = group.permissions.filter(
//       (p) => state[`${group.id}.${p}`]
//     );
//   });
//   return access;
// };