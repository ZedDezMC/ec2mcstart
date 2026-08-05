const net = require('net');
const { runSSMCommandWithOutput } = require('./aws');

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

/**
 * Gửi lệnh RCON trực tiếp từ Node.js qua TCP Socket
 */
function sendDirectRconCommand(host, port, password, command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let isResolved = false;

    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        reject(new Error('RCON direct connection timeout'));
      }
    }, timeoutMs);

    socket.connect(port, host, () => {
      // Send Auth Packet (Type 3)
      const reqId = 1234;
      const authBuf = Buffer.from(password, 'utf8');
      const packetLen = 4 + 4 + authBuf.length + 2;
      const buf = Buffer.alloc(4 + packetLen);

      buf.writeInt32LE(packetLen, 0);
      buf.writeInt32LE(reqId, 4);
      buf.writeInt32LE(3, 8); // Type 3 = Auth
      authBuf.copy(buf, 12);
      buf.writeInt8(0, 12 + authBuf.length);
      buf.writeInt8(0, 12 + authBuf.length + 1);

      socket.write(buf);
    });

    let authenticated = false;

    socket.on('data', (data) => {
      if (!authenticated) {
        if (data.length < 12) return;
        const resId = data.readInt32LE(4);
        if (resId === -1) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timer);
            socket.destroy();
            reject(new Error('Mật khẩu RCON không chính xác'));
          }
          return;
        }

        authenticated = true;

        // Send Command Packet (Type 2)
        const reqId = 1234;
        const cmdBuf = Buffer.from(command, 'utf8');
        const packetLen = 4 + 4 + cmdBuf.length + 2;
        const buf = Buffer.alloc(4 + packetLen);

        buf.writeInt32LE(packetLen, 0);
        buf.writeInt32LE(reqId, 4);
        buf.writeInt32LE(2, 8); // Type 2 = ExecCommand
        cmdBuf.copy(buf, 12);
        buf.writeInt8(0, 12 + cmdBuf.length);
        buf.writeInt8(0, 12 + cmdBuf.length + 1);

        socket.write(buf);
      } else {
        if (data.length >= 12) {
          const body = data.toString('utf8', 12, data.length - 2);
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(body);
          }
        }
      }
    });

    socket.on('error', (err) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      }
    });

    socket.on('close', () => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        reject(new Error('RCON connection closed unexpectedly'));
      }
    });
  });
}

/**
 * Tạo câu lệnh Python RCON để chạy cục bộ trên VPS via AWS SSM
 */
function generateSSMPythonRconCommand(rconPort, rconPassword, minecraftCommand) {
  const safePassword = (rconPassword || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeCommand = (minecraftCommand || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safePort = parseInt(rconPort || '25575', 10);

  return `python3 -c '
import socket, struct, sys

host = "127.0.0.1"
port = ${safePort}
password = "${safePassword}"
cmd = "${safeCommand}"

if not password:
    print("ERR_NO_PASSWORD: Chưa cấu hình RCON_PASSWORD trong file .env")
    sys.exit(1)

try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(6)
    s.connect((host, port))

    req_id = 999
    auth_pkg = struct.pack("<ii", req_id, 3) + password.encode("utf-8") + b"\\x00\\x00"
    s.sendall(struct.pack("<i", len(auth_pkg)) + auth_pkg)

    resp_len = struct.unpack("<i", s.recv(4))[0]
    resp = s.recv(resp_len)
    r_id, r_type = struct.unpack("<ii", resp[:8])

    if r_id == -1:
        print("ERR_AUTH_FAILED: Mật khẩu RCON không chính xác")
        s.close()
        sys.exit(1)

    cmd_pkg = struct.pack("<ii", req_id, 2) + cmd.encode("utf-8") + b"\\x00\\x00"
    s.sendall(struct.pack("<i", len(cmd_pkg)) + cmd_pkg)

    resp_len = struct.unpack("<i", s.recv(4))[0]
    resp = s.recv(resp_len)
    output = resp[8:-2].decode("utf-8", errors="ignore")
    s.close()
    print(output.strip() if output.strip() else "(Lệnh đã được thực thi thành công, không có phản hồi văn bản)")
except Exception as e:
    print(f"ERR_CONNECT_FAILED: Không thể kết nối tới RCON ({e})")
    sys.exit(1)
'`;
}

/**
 * Gửi lệnh Minecraft Console qua RCON (Thử Direct TCP trước, fallback sang AWS SSM Python RCON)
 */
async function sendMinecraftRconCommand(instanceId, publicIp, command) {
  const rconPort = parseInt(process.env.RCON_PORT || process.env.MC_RCON_PORT || '25575', 10);
  const rconPassword = (process.env.RCON_PASSWORD || process.env.MC_RCON_PASSWORD || '').trim();

  if (!rconPassword) {
    throw new Error('Chưa cấu hình RCON_PASSWORD trong file .env của hệ thống. Vui lòng thêm RCON_PASSWORD vào .env và bật enable-rcon=true trong server.properties của Minecraft Server.');
  }

  // Loại bỏ dấu / ở đầu lệnh nếu có (VD: /list -> list)
  const cleanCmd = command.trim().replace(/^\//, '');
  if (!cleanCmd) {
    throw new Error('Lệnh Minecraft không được để trống.');
  }

  // 1. Thử kết nối Direct RCON nếu có Public IP
  if (publicIp) {
    try {
      const directResult = await sendDirectRconCommand(publicIp, rconPort, rconPassword, cleanCmd, 4000);
      return directResult;
    } catch (directErr) {
      console.log(`[RCON Direct Warning] Direct connection to ${publicIp}:${rconPort} failed (${directErr.message}), falling back to AWS SSM...`);
    }
  }

  // 2. Fallback sang AWS SSM Python RCON (chạy local 127.0.0.1 trên VPS)
  const ssmScript = generateSSMPythonRconCommand(rconPort, rconPassword, cleanCmd);
  const ssmResult = await runSSMCommandWithOutput(instanceId, ssmScript, 15000);

  if (!ssmResult.success) {
    const errorMsg = ssmResult.stderr || ssmResult.stdout || `SSM Execution Status: ${ssmResult.status}`;
    throw new Error(errorMsg);
  }

  const output = ssmResult.stdout;
  if (output.startsWith('ERR_AUTH_FAILED')) {
    throw new Error('Mật khẩu RCON không đúng. Vui lòng kiểm tra lại RCON_PASSWORD trong .env và server.properties.');
  }
  if (output.startsWith('ERR_NO_PASSWORD')) {
    throw new Error('Chưa cấu hình RCON_PASSWORD trong file .env.');
  }
  if (output.startsWith('ERR_CONNECT_FAILED')) {
    throw new Error('Không thể kết nối RCON trên VPS. Hãy đảm bảo Minecraft Server đã bật RCON (enable-rcon=true trong server.properties).');
  }

  return output;
}

module.exports = {
  checkMinecraftServerStatus,
  sendMinecraftRconCommand
};
