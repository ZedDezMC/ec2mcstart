require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const { getInstanceStatus, startInstance } = require('./services/aws');
const { checkMinecraftServerStatus } = require('./services/minecraft');
const { initDiscordBot, sendMinecraftStartRequest } = require('./services/discord');

const app = express();
const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.EC2_INSTANCE_ID;
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Khởi tạo Discord Bot khi Server bắt đầu
initDiscordBot();

/**
 * Endpoint kiểm tra Turnstile Captcha Token
 */
async function verifyCaptcha(token, remoteIp) {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  // Nếu chưa cấu hình Secret Key (ví dụ thử nghiệm local), cho phép bỏ qua
  if (!secretKey || secretKey.includes('XXXXXXXX')) {
    console.warn('⚠️ Cloudflare Turnstile Secret Key chưa được cấu hình, bỏ qua xác thực Captcha.');
    return true;
  }

  if (!token) return false;

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (remoteIp) formData.append('remoteip', remoteIp);

    const response = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      formData.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    return response.data && response.data.success === true;
  } catch (error) {
    console.error('Lỗi xác thực Captcha:', error.message);
    return false;
  }
}

/**
 * GET /api/status - Trả về trạng thái EC2 & Server Minecraft
 */
app.get('/api/status', async (req, res) => {
  try {
    if (!INSTANCE_ID || INSTANCE_ID.includes('i-0123456789')) {
      return res.status(500).json({
        error: 'EC2_INSTANCE_ID chưa được cấu hình đúng trong .env'
      });
    }

    const { state, publicIp } = await getInstanceStatus(INSTANCE_ID);
    let mcOnline = false;

    // Nếu EC2 đang chạy và có Public IP, tiến hành check Port Minecraft 25565
    if (state === 'running' && publicIp) {
      mcOnline = await checkMinecraftServerStatus(publicIp, MC_PORT);
    }

    res.json({
      ec2State: state, // 'stopped' | 'pending' | 'running' | 'stopping'
      publicIp,
      mcPort: MC_PORT,
      mcOnline,
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || ''
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Lỗi khi kiểm tra trạng thái' });
  }
});

/**
 * POST /api/start-ec2 - Xác thực Captcha & Bật EC2 Instance
 */
app.post('/api/start-ec2', async (req, res) => {
  try {
    const { captchaToken } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // 1. Xác thực Captcha
    const isCaptchaValid = await verifyCaptcha(captchaToken, clientIp);
    if (!isCaptchaValid) {
      return res.status(400).json({ error: 'Mã Captcha không hợp lệ hoặc đã hết hạn! Vui lòng thử lại.' });
    }

    // 2. Kiểm tra trạng thái EC2 hiện tại
    const currentStatus = await getInstanceStatus(INSTANCE_ID);
    if (currentStatus.state === 'running') {
      return res.json({ message: 'EC2 Instance hiện đã và đang chạy rồi!', state: 'running' });
    }
    if (currentStatus.state === 'pending') {
      return res.json({ message: 'EC2 Instance đang trong quá trình khởi động...', state: 'pending' });
    }

    // 3. Khởi động EC2 Instance
    const result = await startInstance(INSTANCE_ID);
    res.json({
      success: true,
      message: 'Đã gửi lệnh bật EC2 Instance thành công! Đang chờ server khởi động...',
      result
    });

  } catch (error) {
    res.status(500).json({ error: error.message || 'Không thể khởi động EC2 Instance' });
  }
});

/**
 * POST /api/request-mc-start - Gửi yêu cầu qua Discord Bot khi EC2 running nhưng Minecraft offline
 */
app.post('/api/request-mc-start', async (req, res) => {
  try {
    const requesterIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
    const { state, publicIp } = await getInstanceStatus(INSTANCE_ID);

    if (state !== 'running') {
      return res.status(400).json({ error: 'EC2 Instance chưa khởi động xong. Vui lòng bật EC2 trước!' });
    }

    // Kiểm tra xem server Minecraft thực sự offline không
    const isOnline = await checkMinecraftServerStatus(publicIp, MC_PORT);
    if (isOnline) {
      return res.json({ status: 'already_online', message: 'Server Minecraft hiện đã online rồi!' });
    }

    // Gửi yêu cầu qua Discord Bot và chờ kết quả
    const result = await sendMinecraftStartRequest({ requesterIp, publicIp });

    if (result.status === 'approved') {
      return res.json({
        success: true,
        status: 'approved',
        message: `Admin (${result.admin}) đã CHẤP NHẬN! Đã gửi lệnh bật Minecraft Server qua AWS SSM.`
      });
    } else if (result.status === 'rejected') {
      return res.status(403).json({
        success: false,
        status: 'rejected',
        error: `Admin (${result.admin}) đã TỪ CHỐI yêu cầu bật Minecraft Server.`
      });
    } else {
      return res.status(408).json({
        success: false,
        status: 'timeout',
        error: 'Yêu cầu đã HẾT HẠN sau 10 phút vì không nhận được phản hồi từ Admin.'
      });
    }

  } catch (error) {
    res.status(500).json({ error: error.message || 'Lỗi khi gửi yêu cầu đến Discord' });
  }
});

// Khởi chạy Server
app.listen(PORT, () => {
  console.log(`🚀 Server dang chay tai: http://localhost:${PORT}`);
});
