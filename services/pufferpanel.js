const axios = require('axios');

/**
 * Gọi API của PufferPanel để khởi động Minecraft Server
 * @param {string} host IP hoặc Domain của EC2 (Ví dụ: http://x.x.x.x:8080 hoặc http://localhost:8080)
 * @param {string} serverId ID của Server trong PufferPanel
 * @param {string} clientId OAuth2 Client ID tạo trong PufferPanel
 * @param {string} clientSecret OAuth2 Client Secret tạo trong PufferPanel
 */
async function startPufferPanelServer(host, serverId, clientId, clientSecret) {
  try {
    const baseUrl = host.startsWith('http') ? host : `http://${host}:8080`;
    
    // 1. Lấy OAuth2 Access Token từ PufferPanel
    const tokenUrl = `${baseUrl}/oauth2/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const tokenRes = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenRes.data.access_token;
    if (!accessToken) {
      throw new Error('Không lấy được access_token từ PufferPanel OAuth2');
    }

    // 2. Gửi yêu cầu START Server đến PufferPanel API
    const startUrl = `${baseUrl}/api/servers/${serverId}/start`;
    const startRes = await axios.post(startUrl, {}, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    console.log(`✅ PufferPanel Server [${serverId}] đã nhận lệnh START thành công!`);
    return { success: true, data: startRes.data };

  } catch (error) {
    console.error('❌ Lỗi khi gọi PufferPanel API:', error.response?.data || error.message);
    throw new Error(`PufferPanel Error: ${error.response?.data?.error || error.message}`);
  }
}

/**
 * Đợi lệnh curl chạy PufferPanel API cục bộ trên VPS qua AWS SSM RunCommand
 * (Sử dụng khi PufferPanel không mở port 8080 ra ngoài Internet)
 */
function generatePufferPanelSSMCommand(serverId, clientId, clientSecret, pufferPort = 8080) {
  return `
TOKEN=$(curl -s -X POST "http://localhost:${pufferPort}/oauth2/token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}" | grep -o '"access_token":"[^"]*' | grep -o '[^"]*$')

if [ -n "$TOKEN" ]; then
  curl -s -X POST "http://localhost:${pufferPort}/api/servers/${serverId}/start" \\
    -H "Authorization: Bearer $TOKEN"
  echo "PufferPanel server start command executed!"
else
  echo "Failed to obtain PufferPanel token"
fi
  `.trim();
}

module.exports = {
  startPufferPanelServer,
  generatePufferPanelSSMCommand
};
