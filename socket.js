const { Server } = require("socket.io");
let io = null;

function initializeSocket(server) {
  io = new Server(server, { cors: { origin: "*" } });
  io.on("connection", (socket) => {
    socket.emit("serverStatus", { status: "online" });
    socket.on("typing", (data = {}) => socket.broadcast.emit("typing", {
      number: data.number || null,
      typing: !!data.typing,
      time: new Date().toISOString()
    }));
    socket.on("markRead", (data = {}) => socket.broadcast.emit("messagesRead", { number: data.number || null }));
  });
}
function getIO() { return io; }
module.exports = { initializeSocket, getIO };
