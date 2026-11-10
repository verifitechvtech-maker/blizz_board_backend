// src/config/permissions.js
// Single source of truth for roles, modules and the actions each module supports.
// Frontend reads this through GET /api/permissions/catalog — never hardcode it there.

export const ROLES = ["SuperAdmin", "Admin", "Manager", "User"];

// Roles that live INSIDE an Admin's organization (admin_id = that Admin).
export const MEMBER_ROLES = ["Manager", "User"];

export const ROLE_LABELS = {
  SuperAdmin: "Super Admin",
  Admin: "Admin",
  Manager: "Manager",
  User: "Team Member",
};

// Only actions that make sense for each module are listed.
export const MODULES = [
  { id: "tasks",         label: "Tasks Management",         actions: ["view", "create", "edit", "delete", "assign", "import", "export"] },
  { id: "taskbank",      label: "Task Bank",                actions: ["view", "create", "edit", "delete", "assign", "import"] },
  { id: "users",         label: "User Management",          actions: ["view", "create", "edit", "delete", "assign"] },
  { id: "calendar",      label: "Calendar",                 actions: ["view", "create", "edit", "delete", "import"] },
  { id: "reports",       label: "Reports and Analytics",    actions: ["view", "export"] },
  { id: "communication", label: "Minutes of Meeting (MoM)", actions: ["view", "create", "edit", "delete"] },
  { id: "chat",          label: "Chat",                     actions: ["view", "send", "create_group", "manage_members", "upload", "download"] },
  { id: "support",       label: "Support",                  actions: ["view", "create", "edit", "delete"] },
  { id: "settings",      label: "Settings",                 actions: ["view", "edit"] },
];

const MODULE_MAP = Object.fromEntries(MODULES.map((m) => [m.id, m]));

const all = () => Object.fromEntries(MODULES.map((m) => [m.id, [...m.actions]]));

// Starting point for an organization until its Admin saves a custom configuration.
// Communication/Support keep full access so existing MoM / ticket behaviour is unchanged.
export const DEFAULT_ROLE_PERMISSIONS = {
  Admin: all(),
  Manager: {
    tasks: ["view", "create", "edit", "delete", "assign", "import", "export"],
    taskbank: ["view", "create", "edit", "assign", "import"],
    users: ["view"],
    calendar: ["view", "create", "edit", "delete", "import"],
    reports: ["view", "export"],
    communication: ["view", "create", "edit", "delete"],
    chat: ["view", "send", "create_group", "manage_members", "upload", "download"],
    support: ["view", "create", "edit", "delete"],
    settings: ["view", "edit"],
  },
  User: {
    tasks: ["view", "create", "edit", "delete"],
    taskbank: ["view"],
    users: [],
    calendar: ["view", "create", "edit"],
    reports: [],
    communication: ["view", "create", "edit", "delete"],
    chat: ["view", "send", "upload", "download"],
    support: ["view", "create", "edit", "delete"],
    settings: ["view", "edit"],
  },
};

export const fullPermissions = all;

// Human-readable action names (Roles page)
export const ACTION_LABELS = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
  assign: "Assign",
  import: "Import",
  export: "Export",
  send: "Send messages",
  create_group: "Create groups",
  manage_members: "Add / remove group members",
  upload: "Upload attachments",
  download: "Download / view attachments",
};

/**
 * Drop unknown modules/actions and de-duplicate.
 * Always returns an object containing every module key.
 */
// `fallback` fills modules that are missing entirely (configs saved before a module existed)
export const sanitizePermissions = (input, fallback = null) => {
  const clean = {};
  for (const mod of MODULES) {
    const has = input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, mod.id);
    const raw = has ? input[mod.id] : fallback ? fallback[mod.id] : [];
    const list = Array.isArray(raw) ? raw : [];
    clean[mod.id] = mod.actions.filter((a) => list.includes(a));
  }
  return clean;
};

// Keep only what BOTH permission sets allow.
export const intersectPermissions = (a, b) => {
  const out = {};
  for (const mod of MODULES) {
    const right = new Set(b?.[mod.id] || []);
    out[mod.id] = (a?.[mod.id] || []).filter((x) => right.has(x));
  }
  return out;
};

// true when every action in `subset` is also in `superset`.
export const isSubset = (subset, superset) =>
  MODULES.every((mod) =>
    (subset?.[mod.id] || []).every((a) => (superset?.[mod.id] || []).includes(a))
  );

export const can = (permissions, moduleId, action) =>
  Boolean(permissions?.[moduleId]?.includes(action));

export const isValidModuleAction = (moduleId, action) =>
  Boolean(MODULE_MAP[moduleId]?.actions.includes(action));

export const countPermissions = (permissions) =>
  MODULES.reduce((n, m) => n + (permissions?.[m.id]?.length || 0), 0);
