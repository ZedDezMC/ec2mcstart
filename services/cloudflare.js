const axios = require('axios');

let lastSyncedIp = null;
let isSyncing = false;

/**
 * Tự động đồng bộ Public IP mới của EC2 lên Cloudflare DNS (Record A)
 * @param {string} publicIp IP mới của EC2 Instance
 */
async function syncCloudflareDNS(publicIp) {
  if (!publicIp || publicIp === lastSyncedIp || isSyncing) {
    return;
  }

  const apiToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const zoneId = (process.env.CLOUDFLARE_ZONE_ID || '').trim();
  let recordName = (process.env.CLOUDFLARE_RECORD_NAME || process.env.CUSTOM_SERVER_ADDRESS || '').trim();

  // Loại bỏ port nếu recordName có dạng domain:port
  if (recordName.includes(':')) {
    recordName = recordName.split(':')[0];
  }

  // Nếu chưa cấu hình token hoặc zone ID, đưa ra cảnh báo và bỏ qua
  if (!apiToken || !zoneId || !recordName) {
    return;
  }

  isSyncing = true;
  console.log(`[Cloudflare DDNS] Đang kiểm tra đồng bộ DNS cho domain ${recordName} -> IP: ${publicIp}...`);

  try {
    const headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    };

    // 1. Tìm bản ghi A hiện tại trên Cloudflare
    const searchUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${recordName}`;
    const searchRes = await axios.get(searchUrl, { headers });

    if (!searchRes.data || !searchRes.data.success) {
      throw new Error(`Lỗi tìm bản ghi DNS: ${JSON.stringify(searchRes.data?.errors || [])}`);
    }

    const records = searchRes.data.result || [];
    const existingRecord = records.find(r => r.name === recordName && r.type === 'A');

    if (existingRecord) {
      if (existingRecord.content === publicIp) {
        console.log(`[Cloudflare DDNS] Bản ghi A ${recordName} đã khớp với IP (${publicIp}). Không cần cập nhật.`);
        lastSyncedIp = publicIp;
        isSyncing = false;
        return;
      }

      // 2. Cập nhật bản ghi A nếu IP đã thay đổi
      const updateUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existingRecord.id}`;
      const updateRes = await axios.put(updateUrl, {
        type: 'A',
        name: recordName,
        content: publicIp,
        ttl: 60,
        proxied: false // Bắt buộc false cho Minecraft TCP (DNS Only)
      }, { headers });

      if (updateRes.data && updateRes.data.success) {
        console.log(`[Cloudflare DDNS] SUCCESS: Đã cập nhật bản ghi A ${recordName} -> ${publicIp} (IP cũ: ${existingRecord.content})`);
        lastSyncedIp = publicIp;
      } else {
        throw new Error(`Không thể cập nhật DNS: ${JSON.stringify(updateRes.data?.errors || [])}`);
      }

    } else {
      // 3. Tạo bản ghi A mới nếu chưa tồn tại
      const createUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
      const createRes = await axios.post(createUrl, {
        type: 'A',
        name: recordName,
        content: publicIp,
        ttl: 60,
        proxied: false
      }, { headers });

      if (createRes.data && createRes.data.success) {
        console.log(`[Cloudflare DDNS] SUCCESS: Đã tạo mới bản ghi A ${recordName} -> ${publicIp}`);
        lastSyncedIp = publicIp;
      } else {
        throw new Error(`Không thể tạo mới DNS: ${JSON.stringify(createRes.data?.errors || [])}`);
      }
    }

  } catch (error) {
    console.error('[Cloudflare DDNS Error]', error.response?.data || error.message);
  } finally {
    isSyncing = false;
  }
}

module.exports = {
  syncCloudflareDNS
};
