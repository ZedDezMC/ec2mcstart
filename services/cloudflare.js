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
  const apiKey = (process.env.CLOUDFLARE_API_KEY || process.env.CLOUDFLARE_GLOBAL_KEY || '').trim();
  const email = (process.env.CLOUDFLARE_EMAIL || '').trim();
  const zoneId = (process.env.CLOUDFLARE_ZONE_ID || '').trim();
  let recordName = (process.env.CLOUDFLARE_RECORD_NAME || process.env.CUSTOM_SERVER_ADDRESS || '').trim();

  // Loại bỏ port nếu recordName có dạng domain:port
  if (recordName.includes(':')) {
    recordName = recordName.split(':')[0];
  }

  // Nếu chưa cấu hình token/key hoặc zone ID, bỏ qua
  if (!zoneId || !recordName || (!apiToken && (!apiKey || !email))) {
    return;
  }

  isSyncing = true;
  console.log(`[Cloudflare DDNS] Đang kiểm tra đồng bộ DNS cho domain ${recordName} -> IP: ${publicIp}...`);

  try {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (apiToken) {
      headers['Authorization'] = `Bearer ${apiToken}`;
    } else if (apiKey && email) {
      headers['X-Auth-Email'] = email;
      headers['X-Auth-Key'] = apiKey;
    }

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
    const errData = error.response?.data;
    if (errData && errData.errors && errData.errors.some(e => e.code === 10000)) {
      console.error(`[Cloudflare DDNS Error] Lỗi xác thực (Code 10000: Authentication error).`);
      console.error(`👉 Nguyên nhân: API Token hoặc Zone ID trong .env chưa đúng / chưa đủ quyền.`);
      console.error(`👉 Cách khắc phục:`);
      console.error(`   - Cách 1 (API Token): Tạo Token tại Cloudflare (My Profile -> API Tokens -> Create Token -> Edit zone DNS). Đảm bảo chọn Zone Resources là "All zones" hoặc chọn đúng tên miền hsown.xyz.`);
      console.error(`   - Cách 2 (Global API Key): Nếu dùng Global API Key, mở .env và điền thêm CLOUDFLARE_EMAIL=email_cua_ban và CLOUDFLARE_API_KEY=key_cua_ban.`);
    } else {
      console.error('[Cloudflare DDNS Error]', errData || error.message);
    }
  } finally {
    isSyncing = false;
  }
}

module.exports = {
  syncCloudflareDNS
};
