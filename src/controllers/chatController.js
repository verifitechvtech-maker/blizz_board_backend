
import mongoose from "mongoose";
import User from "../models/User.js";
import Department from "../models/Department.js";
import Conversation from "../models/Conversation.js";
import Message, { notExpired } from "../models/Message.js";
import { recordChatFiles } from "../services/chatBackupService.js";
import { pushChatMessage } from "../services/pushService.js";

/* =====================================================
   HELPERS
===================================================== */

const getCurrentUserId = (req) =>
  req.user?._id || req.user?.userId || req.user?.id || null;

const sameId = (a, b) =>
  Boolean(a && b) && String(a) === String(b);

const isAdmin = (user) =>
  ["Admin", "SuperAdmin"].includes(user?.role);

const getOrganizationId = (user) => {
  if (!user) return null;
  if (user.admin_id) return user.admin_id;
  if (isAdmin(user)) return user._id;
  return user.createdBy || null;
};

const getRequestOrganizationId = (req, user) =>
  req.adminId || getOrganizationId(user);

const getAuthenticatedUser = async (req) => {
  const id = getCurrentUserId(req);
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return User.findById(id);
};

const escapeRegex = (value) =>
  String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getSocketIO = (req) => req.app.get("io");

const emitToUser = (io, userId, event, payload) => {
  if (io && userId) {
    io.to(`user:${String(userId)}`).emit(event, payload);
  }
};

const departmentOrganizationFilter = (organizationId) => ({
  $or: [
    { admin_id: organizationId },
    { createdBy: organizationId },
  ],
});

/* =====================================================
   DEPARTMENT ACCESS
===================================================== */

async function getUserDepartmentIds(user, organizationId) {
  if (!user) return [];

  let filter = { status: "Active" };

  if (user.role !== "SuperAdmin") {
    if (!organizationId) return [];

    filter = {
      status: "Active",
      ...departmentOrganizationFilter(organizationId),
    };
  }

  const departments = await Department.find(filter).select("_id");
  return departments.map((department) => department._id);
}

async function canAccessDepartment(user, department, organizationId) {
  if (!user || !department || department.status !== "Active") {
    return false;
  }

  if (user.role === "SuperAdmin") return true;
  if (!organizationId) return false;

  return (
    sameId(department.admin_id, organizationId) ||
    sameId(department.createdBy, organizationId)
  );
}

async function getConversationAccessFilter(user, organizationId) {
  const conditions = [];

  if (organizationId) {
    conditions.push({
      type: "private",
      admin_id: organizationId,
      participants: user._id,
    });
  }

  const departmentIds = await getUserDepartmentIds(
    user,
    organizationId
  );

  if (departmentIds.length) {
    conditions.push({
      type: "department",
      department: { $in: departmentIds },
    });
  }

  // Groups: only their members
  conditions.push({ type: "group", participants: user._id });

  // SuperAdmin can see all conversations, but only department
  // conversations associated with existing active departments.
  if (user.role === "SuperAdmin") {
    conditions.push({ type: "private" });
  }

  return conditions.length ? { $or: conditions } : { _id: null };
}

async function getUnreadCounts(conversationIds, userId) {
  if (!conversationIds.length) return {};

  const userObjectId = new mongoose.Types.ObjectId(String(userId));

  const counts = await Message.aggregate([
    {
      $match: {
        conversation: {
          $in: conversationIds.map(
            (id) => new mongoose.Types.ObjectId(String(id))
          ),
        },
        sender: { $ne: userObjectId },
        readBy: { $ne: userObjectId },
        ...notExpired(),
      },
    },
    {
      $group: {
        _id: "$conversation",
        count: { $sum: 1 },
      },
    },
  ]);

  return counts.reduce((result, item) => {
    result[String(item._id)] = item.count;
    return result;
  }, {});
}

async function getConversationRecipientIds(conversation, senderId) {
  if (conversation.type === "private" || conversation.type === "group") {
    const users = await User.find({
      _id: { $in: conversation.participants || [] },
      status: "Active",
    }).select("_id");

    return users
      .filter((user) => !sameId(user._id, senderId))
      .map((user) => String(user._id));
  }

  if (conversation.type !== "department" || !conversation.department) {
    return [];
  }

  const department = await Department.findOne({
    _id: conversation.department,
    status: "Active",
  }).select("_id name admin_id createdBy");

  if (!department) return [];

  const organizationConditions = [];

  if (department.admin_id) {
    organizationConditions.push({ admin_id: department.admin_id });
  }

  if (department.createdBy) {
    organizationConditions.push({ createdBy: department.createdBy });
  }

  if (!organizationConditions.length) return [];

  const users = await User.find({
    status: "Active",
    department: {
      $regex: `^${escapeRegex(department.name)}$`,
      $options: "i",
    },
    $or: organizationConditions,
    _id: { $ne: senderId },
  }).select("_id");

  return users.map((user) => String(user._id));
}

/* =====================================================
   GET /api/chat/users
===================================================== */

export const getChatUsers = async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (currentUser.status !== "Active") {
      return res.status(403).json({
        success: false,
        message: "Your account is inactive.",
      });
    }

    const organizationId = getRequestOrganizationId(req, currentUser);

    if (!organizationId && currentUser.role !== "SuperAdmin") {
      return res.status(403).json({
        success: false,
        message: "Organization could not be identified.",
      });
    }

    const userFilter = {
      status: "Active",
      _id: { $ne: currentUser._id },
    };

    if (currentUser.role !== "SuperAdmin") {
      userFilter.$or = [
        { admin_id: organizationId },
        { createdBy: organizationId },
      ];
    }

    const users = await User.find(userFilter)
      .select("_id name email phone department role status")
      .sort({ name: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: users.length,
      users,
    });
  } catch (error) {
    console.error("getChatUsers:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load chat users.",
    });
  }
};

/* =====================================================
   GET /api/chat/departments
===================================================== */

export const getChatDepartments = async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (currentUser.status !== "Active") {
      return res.status(403).json({
        success: false,
        message: "Your account is inactive.",
      });
    }

    const organizationId = getRequestOrganizationId(req, currentUser);
    let filter = { status: "Active" };

    if (currentUser.role !== "SuperAdmin") {
      if (!organizationId) {
        return res.status(403).json({
          success: false,
          message: "Organization could not be identified.",
        });
      }

      filter = {
        status: "Active",
        ...departmentOrganizationFilter(organizationId),
      };
    }

    const departments = await Department.find(filter)
      .select("_id name departmentName description status admin_id createdBy")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Departments fetched successfully.",
      count: departments.length,
      data: departments,
    });
  } catch (error) {
    console.error("getChatDepartments:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load departments.",
    });
  }
};

/* =====================================================
   POST /api/chat/private
===================================================== */

export const createPrivateConversation = async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    const { userId } = req.body || {};

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (currentUser.status !== "Active") {
      return res.status(403).json({
        success: false,
        message: "Your account is inactive.",
      });
    }

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({
        success: false,
        message: "A valid userId is required.",
      });
    }

    if (sameId(userId, currentUser._id)) {
      return res.status(400).json({
        success: false,
        message: "You cannot chat with yourself.",
      });
    }

    const organizationId = getRequestOrganizationId(req, currentUser);

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        message: "Organization could not be identified.",
      });
    }

    const recipient = await User.findOne({
      _id: userId,
      status: "Active",
      $or: [
        { admin_id: organizationId },
        { createdBy: organizationId },
      ],
    });

    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: "Chat user not found in your organization.",
      });
    }

    const participants = [currentUser._id, recipient._id].sort(
      (a, b) => String(a).localeCompare(String(b))
    );

    let conversation = await Conversation.findOne({
      type: "private",
      admin_id: organizationId,
      participants: { $all: participants, $size: 2 },
    });

    if (!conversation) {
      conversation = await Conversation.create({
        type: "private",
        admin_id: organizationId,
        participants,
        createdBy: currentUser._id,
      });
    }

    conversation = await Conversation.findById(conversation._id)
      .populate("participants", "name email department role status");

    return res.status(200).json({ success: true, conversation });
  } catch (error) {
    console.error("createPrivateConversation:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to create private conversation.",
    });
  }
};

/* =====================================================
   POST /api/chat/department
===================================================== */

export const createDepartmentConversation = async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    const departmentId =
      req.body?.departmentId ||
      req.body?.department_id ||
      req.body?.department;

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (currentUser.status !== "Active") {
      return res.status(403).json({
        success: false,
        message: "Your account is inactive.",
      });
    }

    if (!mongoose.isValidObjectId(departmentId)) {
      return res.status(400).json({
        success: false,
        message: "A valid departmentId is required.",
      });
    }

    const organizationId = getRequestOrganizationId(req, currentUser);
    const department = await Department.findById(departmentId);

    if (
      !department ||
      !(await canAccessDepartment(currentUser, department, organizationId))
    ) {
      return res.status(404).json({
        success: false,
        message: "Department not found or access denied.",
      });
    }

    const conversationOrganizationId =
      department.admin_id ||
      department.createdBy ||
      organizationId ||
      currentUser._id;

    let conversation = await Conversation.findOne({
      type: "department",
      admin_id: conversationOrganizationId,
      department: department._id,
    });

    if (!conversation) {
      try {
        conversation = await Conversation.create({
          type: "department",
          admin_id: conversationOrganizationId,
          department: department._id,
          participants: [],
          createdBy: currentUser._id,
        });
      } catch (error) {
        if (error.code !== 11000) throw error;

        conversation = await Conversation.findOne({
          type: "department",
          admin_id: conversationOrganizationId,
          department: department._id,
        });

        if (!conversation) throw error;
      }
    }

    conversation = await Conversation.findById(conversation._id)
      .populate("department", "name description")
      .populate("participants", "name email department role status")
      .populate({
        path: "lastMessage",
        select: "text attachments sender createdAt expiresAt system",
        populate: { path: "sender", select: "name" },
      });

    return res.status(200).json({ success: true, conversation });
  } catch (error) {
    console.error("createDepartmentConversation:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to open department conversation.",
    });
  }
};

/* =====================================================
   GET /api/chat/conversations
===================================================== */

export const getConversations = async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (currentUser.status !== "Active") {
      return res.status(403).json({
        success: false,
        message: "Your account is inactive.",
      });
    }

    const organizationId = getRequestOrganizationId(req, currentUser);

    if (!organizationId && currentUser.role !== "SuperAdmin") {
      return res.status(403).json({
        success: false,
        message: "Organization could not be identified.",
      });
    }

    const accessFilter = await getConversationAccessFilter(
      currentUser,
      organizationId
    );

    const conversations = await Conversation.find(accessFilter)
      .populate("participants", "name email department role status")
      .populate("department", "name description")
      .populate({
        path: "lastMessage",
        select: "text attachments sender createdAt expiresAt system",
        populate: { path: "sender", select: "name" },
      })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .lean();

    const visibleConversations = conversations.filter((conversation) => {
      if (conversation.type !== "private") return true;

      const participants = conversation.participants || [];

      if (
        participants.length !== 2 ||
        participants.some((participant) => !participant?._id)
      ) {
        return false;
      }

      const otherParticipant = participants.find(
        (participant) => !sameId(participant._id, currentUser._id)
      );

      return Boolean(
        otherParticipant && otherParticipant.status === "Active"
      );
    });

    const unreadCounts = await getUnreadCounts(
      visibleConversations.map((conversation) => conversation._id),
      currentUser._id
    );

    // an expired last message is hidden until jobs/chatExpiryJob.js removes it
    const now = Date.now();
    const result = visibleConversations.map((conversation) => ({
      ...conversation,
      lastMessage:
        conversation.lastMessage?.expiresAt && new Date(conversation.lastMessage.expiresAt).getTime() <= now
          ? null
          : conversation.lastMessage,
      unreadCount: unreadCounts[String(conversation._id)] || 0,
    }));

    return res.status(200).json({
      success: true,
      count: result.length,
      conversations: result,
    });
  } catch (error) {
    console.error("getConversations:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load conversations.",
    });
  }
};

/* =====================================================
   GET /api/chat/:conversationId/messages
===================================================== */

export const getMessages = async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    const { conversationId } = req.params;

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!mongoose.isValidObjectId(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID.",
      });
    }

    const organizationId = getRequestOrganizationId(req, currentUser);
    const accessFilter = await getConversationAccessFilter(
      currentUser,
      organizationId
    );

    const conversation = await Conversation.findOne({
      _id: conversationId,
      ...accessFilter,
    });

    if (!conversation) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this conversation.",
      });
    }

    if (conversation.type === "department") {
      const department = await Department.findById(conversation.department);

      if (
        !(await canAccessDepartment(
          currentUser,
          department,
          organizationId
        ))
      ) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this department chat.",
        });
      }
    }

    if (conversation.type === "private") {
      const participantIds = (conversation.participants || []).map(String);
      const count = await User.countDocuments({
        _id: { $in: participantIds },
      });

      if (participantIds.length !== 2 || count !== 2) {
        return res.status(404).json({
          success: false,
          message: "This conversation is no longer available.",
        });
      }
    }

    const unreadFilter = {
      conversation: conversation._id,
      sender: { $ne: currentUser._id },
      readBy: { $ne: currentUser._id },
    };
    // whose messages are being seen now, so their ticks turn "seen"
    const seenSenders = await Message.distinct("sender", unreadFilter);

    if (seenSenders.length) {
      await Message.updateMany(unreadFilter, {
        $addToSet: { readBy: currentUser._id },
      });

      const io = getSocketIO(req);
      for (const senderId of seenSenders) {
        emitToUser(io, senderId, "chat:messages:read", {
          conversationId: String(conversation._id),
          readerId: String(currentUser._id),
          readerName: currentUser.name || "",
          readAt: new Date().toISOString(),
        });
      }
    }

    const messages = await Message.find({
      conversation: conversation._id,
      ...notExpired(),
    })
      .populate("sender", "name email")
      .sort({ createdAt: 1 })
      .limit(200);

    emitToUser(getSocketIO(req), currentUser._id, "chat:unread:update", {
      conversationId: String(conversation._id),
      unreadCount: 0,
    });

    return res.status(200).json({
      success: true,
      count: messages.length,
      messages,
    });
  } catch (error) {
    console.error("getMessages:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load messages.",
    });
  }
};

/* =====================================================
   POST /api/chat/:conversationId/messages
===================================================== */

export const sendMessage = async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    const { conversationId } = req.params;
    const text = String(req.body?.text || "").trim();
    const files = req.files || [];

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (currentUser.status !== "Active") {
      return res.status(403).json({
        success: false,
        message: "Your account is inactive.",
      });
    }

    if (!mongoose.isValidObjectId(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID.",
      });
    }

    if (!text && !files.length) {
      return res.status(400).json({
        success: false,
        message: "Type a message or attach a file.",
      });
    }

    const organizationId = getRequestOrganizationId(req, currentUser);
    const accessFilter = await getConversationAccessFilter(
      currentUser,
      organizationId
    );

    const conversation = await Conversation.findOne({
      _id: conversationId,
      ...accessFilter,
    });

    if (!conversation) {
      return res.status(403).json({
        success: false,
        message: "You cannot send messages to this conversation.",
      });
    }

    if (conversation.type === "department") {
      const department = await Department.findById(conversation.department);

      if (
        !(await canAccessDepartment(
          currentUser,
          department,
          organizationId
        ))
      ) {
        return res.status(403).json({
          success: false,
          message: "You cannot send messages to this department.",
        });
      }
    }

    if (conversation.type === "private") {
      const participantIds = (conversation.participants || []).map(String);
      const count = await User.countDocuments({
        _id: { $in: participantIds },
        status: "Active",
      });

      if (participantIds.length !== 2 || count !== 2) {
        return res.status(404).json({
          success: false,
          message: "This conversation is no longer available.",
        });
      }
    }

    const message = await Message.create({
      conversation: conversation._id,
      sender: currentUser._id,
      text,
      attachments: files.map((f) => ({
        filename: f.filename,
        name: f.originalname,
        size: f.size,
        mimetype: f.mimetype,
      })),
      readBy: [currentUser._id],
      expiresAt:
        conversation.disappearAfter > 0
          ? new Date(Date.now() + conversation.disappearAfter * 1000)
          : null,
    });

    conversation.lastMessage = message._id;
    conversation.lastMessageAt = message.createdAt || new Date();
    await conversation.save();

    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "name email");

    // Every shared file is kept in the chat file backup (Settings → Chat file backup)
    if (message.attachments?.length) {
      try {
        const recipients = await getConversationRecipientIds(conversation, currentUser._id);
        await recordChatFiles(message, conversation, {
          senderName: currentUser.name || "",
          visibleTo: recipients,
        });
      } catch (err) {
        console.error("chat file backup:", err.message);
      }
    }

    const io = getSocketIO(req);

    if (io) {
      const recipientIds = await getConversationRecipientIds(
        conversation,
        currentUser._id
      );

      for (const recipientId of recipientIds) {
        const unreadCount = await Message.countDocuments({
          conversation: conversation._id,
          sender: { $ne: recipientId },
          readBy: { $ne: recipientId },
          ...notExpired(),
        });

        emitToUser(io, recipientId, "chat:message:new", {
          conversationId: String(conversation._id),
          message: populatedMessage,
        });

        emitToUser(io, recipientId, "chat:unread:update", {
          conversationId: String(conversation._id),
          unreadCount,
        });
      }
    }

    // push to their browsers too (works when the app is closed)
    getConversationRecipientIds(conversation, currentUser._id)
      .then((recipientIds) =>
        pushChatMessage(recipientIds, {
          conversationId: String(conversation._id),
          senderName: currentUser.name || "Someone",
          text: message.text || "",
          attachments: message.attachments?.length || 0,
          chatName: conversation.type === "private" ? "" : conversation.name || "",
        })
      )
      .catch((err) => console.error("[push] chat:", err.message));

    return res.status(201).json({
      success: true,
      message: populatedMessage,
    });
  } catch (error) {
    console.error("sendMessage:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to send message.",
    });
  }
};

/* =====================================================
   PUT /api/chat/:conversationId/disappearing
   body: { seconds: 0 | 3600 | 86400 | 604800 | 7776000 }
   Applies to messages sent after the change.
   Private chat → either person · Group → group admins / org Admin
   Department → Admin / Manager / SuperAdmin
===================================================== */

export const DISAPPEAR_OPTIONS = {
  0: "Off",
  3600: "1 hour",
  86400: "24 hours",
  604800: "7 days",
  7776000: "90 days",
};

export const setDisappearingMessages = async (req, res) => {
  try {
    const currentUser = await getAuthenticatedUser(req);
    const { conversationId } = req.params;
    const seconds = Number(req.body?.seconds);

    if (!currentUser || currentUser.status !== "Active") {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!mongoose.isValidObjectId(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID.",
      });
    }

    if (!Object.prototype.hasOwnProperty.call(DISAPPEAR_OPTIONS, seconds)) {
      return res.status(400).json({
        success: false,
        message: `Choose one of: ${Object.values(DISAPPEAR_OPTIONS).join(", ")}.`,
      });
    }

    const organizationId = getRequestOrganizationId(req, currentUser);
    const accessFilter = await getConversationAccessFilter(
      currentUser,
      organizationId
    );

    const conversation = await Conversation.findOne({
      _id: conversationId,
      ...accessFilter,
    });

    if (!conversation) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this conversation.",
      });
    }

    const role = currentUser.role;
    let allowed = false;

    if (conversation.type === "private") {
      allowed = (conversation.participants || []).some((id) => sameId(id, currentUser._id));
    } else if (conversation.type === "group") {
      allowed =
        role === "SuperAdmin" ||
        sameId(conversation.admin_id, currentUser._id) ||
        (conversation.groupAdmins || []).some((id) => sameId(id, currentUser._id));
    } else if (conversation.type === "department") {
      const department = await Department.findById(conversation.department);
      allowed =
        ["SuperAdmin", "Admin", "Manager"].includes(role) &&
        (await canAccessDepartment(currentUser, department, organizationId));
    }

    if (!allowed) {
      return res.status(403).json({
        success: false,
        message:
          conversation.type === "group"
            ? "Only group admins can change disappearing messages."
            : "Only an Admin or Manager can change disappearing messages for a department chat.",
      });
    }

    if ((conversation.disappearAfter || 0) === seconds) {
      return res.status(200).json({ success: true, conversation });
    }

    conversation.disappearAfter = seconds;
    conversation.disappearSetBy = currentUser._id;
    conversation.disappearSetAt = new Date();

    // A note in the chat so everyone sees the change (the note itself never disappears)
    const note = await Message.create({
      conversation: conversation._id,
      sender: currentUser._id,
      system: true,
      text: seconds
        ? `${currentUser.name || "Someone"} turned on disappearing messages. New messages will disappear ${DISAPPEAR_OPTIONS[seconds]} after they're sent.`
        : `${currentUser.name || "Someone"} turned off disappearing messages.`,
      readBy: [currentUser._id],
    });

    conversation.lastMessage = note._id;
    conversation.lastMessageAt = note.createdAt || new Date();
    await conversation.save();

    const populatedNote = await Message.findById(note._id).populate("sender", "name email");
    const io = getSocketIO(req);

    if (io) {
      const recipientIds = await getConversationRecipientIds(conversation, currentUser._id);
      const payload = {
        conversationId: String(conversation._id),
        disappearAfter: seconds,
      };

      for (const recipientId of [...recipientIds, String(currentUser._id)]) {
        emitToUser(io, recipientId, "chat:conversation:update", payload);
      }
      for (const recipientId of recipientIds) {
        emitToUser(io, recipientId, "chat:message:new", {
          conversationId: String(conversation._id),
          message: populatedNote,
        });
      }
    }

    return res.status(200).json({
      success: true,
      conversation,
      message: populatedNote,
    });
  } catch (error) {
    console.error("setDisappearingMessages:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to change disappearing messages.",
    });
  }
};
