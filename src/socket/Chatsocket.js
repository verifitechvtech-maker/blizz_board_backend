import jwt from "jsonwebtoken";
import User from "../models/User.js";

export const registerChatSocket = (io) => {
  // Authenticate every Socket.IO connection.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error("Authentication required"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = decoded.id || decoded._id || decoded.userId;

      if (!userId) {
        return next(new Error("Invalid token payload"));
      }

      const user = await User.findById(userId).select(
        "_id name email role department status admin_id"
      );

      if (!user || user.status !== "Active") {
        return next(new Error("User not found or inactive"));
      }

      socket.user = user;
      next();
    } catch (error) {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`Chat connected: ${socket.user.name}`);

    // A private room for delivering messages to this user.
    socket.join(`user:${socket.user._id}`);

    socket.on("disconnect", () => {
      console.log(`Chat disconnected: ${socket.user.name}`);
    });
  });
};