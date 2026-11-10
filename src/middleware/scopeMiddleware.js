// src/middleware/scopeMiddleware.js

/**
 * Data isolation for ALL modules.
 * SuperAdmin -> {}                              (sees everything)
 * Admin      -> { admin_id: me }                (my org only)
 * Manager    -> { admin_id: myAdmin, my department's records + my own records }
 * User       -> { admin_id: myAdmin, only my records }
 */
export const attachScope = (req, res, next) => {
  const u = req.user;

  // Records "belonging" to a member (tasks, MoMs, chats)
  const ownRecords = [
    { assignedTo: u._id },      // tasks assigned to me
    { assignedBy: u._id },      // tasks I created/assigned
    { createdBy: u._id },       // records I created
    { attendees: u._id },       // MoMs I attend
    { participants: u._id },    // chats I'm in
  ];

  if (u.role === "SuperAdmin") {
    req.scope = {};                 // everything
    req.adminId = null;

  } else if (u.role === "Admin") {
    req.scope = { admin_id: u._id };  // my org only
    req.adminId = u._id;

  } else if (u.role === "Manager") {
    // Manager → his org; whole department when he has one, else only his records
    req.scope = {
      admin_id: u.admin_id,
      // a task with several departments counts for each of them
      $or: u.department
        ? [{ department: u.department }, { departments: u.department }, ...ownRecords]
        : ownRecords,
    };
    req.adminId = u.admin_id;

  } else {
    // Normal User → only HIS admin's data + only HIS records
    req.scope = {
      admin_id: u.admin_id,
      $or: ownRecords,
    };
    req.adminId = u.admin_id;
  }
  next();
};
