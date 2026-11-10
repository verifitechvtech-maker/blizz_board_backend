import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },

    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Text is optional when the message carries attachments
    text: {
      type: String,
      trim: true,
      default: "",
      // no length limit on text — only files are limited (5 MB each)
    },
    // Files are stored on disk (uploads/chat); only metadata is kept here
    attachments: [
      {
        _id: false,
        filename: { type: String, required: true },
        name: { type: String, required: true },
        size: { type: Number, default: 0 },
        mimetype: { type: String, default: "" },
      },
    ],

    // Disappearing messages: hidden from then on, and removed by jobs/chatExpiryJob.js
    expiresAt: {
      type: Date,
      default: null,
    },
    // "X turned on disappearing messages" style notes
    system: {
      type: Boolean,
      default: false,
    },

    // Supports read receipts later.
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ expiresAt: 1 }, { partialFilterExpression: { expiresAt: { $type: "date" } } });

// Matches messages that have not disappeared yet (no expiry, or expiry in the future)
export const notExpired = () => ({ expiresAt: { $not: { $lte: new Date() } } });

const Message =
  mongoose.models.Message || mongoose.model("Message", messageSchema);

export default Message;