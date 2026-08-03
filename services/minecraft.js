const net = require('net');

/**
 * Kiểm tra xem Minecraft Server có đang mở port TCP (25565) hay không
 * @param {string} host IP hoặc Domain của EC2 Instance
 * @param {number} port Port Minecraft (Mặc định 25565)
 * @param {number} timeout Ms chờ phản hồi socket (Mặc định 3000ms)
 * @returns {Promise<boolean>} True nếu port đang mở (server online)
 */
function checkMinecraftServerStatus(host, port = 25565, timeout = 3000) {
  return new Promise((resolve) => {
    if (!host) {
      return resolve(false);
    }

    const socket = new net.Socket();
    let isOnline = false;

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      isOnline = true;
      socket.destroy();
    });

    socket.on('timeout', () => {
      socket.destroy();
    });

    socket.on('error', (err) => {
      socket.destroy();
    });

    socket.on('close', () => {
      resolve(isOnline);
    });

    socket.connect(port, host);
  });
}

module.exports = {
  checkMinecraftServerStatus
};
