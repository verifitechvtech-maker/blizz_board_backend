import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["private", "department", "group"],
      required: true,
    },

    // Organization isolation
    admin_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Used for private conversations
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],

    // Used for department conversations
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      default: null,
    },

    // Group chats: display name + who may manage members
    name: {
      type: String,
      trim: true,
      default: "",
      maxlength: 80,
    },
    groupAdmins: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },

    // Disappearing messages: new messages are deleted this many seconds after sending (0 = off)
    disappearAfter: {
      type: Number,
      default: 0,
      min: 0,
    },
    disappearSetBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    disappearSetAt: {
      type: Date,
      default: null,
    },

    lastMessageAt: {
      type: Date,
      default: Date.now,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Prevent duplicate private conversations between the same two users.
// The participant IDs are sorted before saving in the controller.
conversationSchema.index(
  { type: 1, admin_id: 1, participants: 1 },
  { unique: false }
);

// One department conversation per department per organization.
conversationSchema.index(
  { type: 1, admin_id: 1, department: 1 },
  {
    unique: true,
    partialFilterExpression: { type: "department" },
  }
);

const Conversation =
  mongoose.models.Conversation ||
  mongoose.model("Conversation", conversationSchema);

export default Conversation;