// Push events to a user's open browser tabs (room "user:<id>", joined in Chatsocket.js).
let ioRef = null;

export const setRealtimeIO = (io) => {
  ioRef = io;
};

export const emitToUser = (userId, event, payload) => {
  if (ioRef && userId) ioRef.to(`user:${String(userId)}`).emit(event, payload);
};
