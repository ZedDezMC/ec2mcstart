const { 
  Client, 
  GatewayIntentBits, 
  Partials,
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle 
} = require('discord.js');
const { runSSMStartMinecraftCommand } = require('./aws');
const { generatePufferPanelSSMCommand, startPufferPanelServer } = require('./pufferpanel');

let client = null;
const pendingRequests = new Map(); // reqId -> { resolve, reject, message, timer }

/**
 * Nút điều khiển Chế độ Server (Dev Mode vs Normal Mode)
 */
function getModeActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('set_dev_mode')
      .setLabel('Bật Dev Mode (Không tự tắt)')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🛠️'),
    new ButtonBuilder()
      .setCustomId('set_normal_mode')
      .setLabel('Bật Normal Mode (Tự tắt sau 30p)')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🟢')
  );
}

/**
 * Khởi tạo Discord Bot Client
 */
function initDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || token.includes('XXXXXX')) {
    console.warn('⚠️ [Discord Bot] DISCORD_BOT_TOKEN chưa được cấu hình trong .env');
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [
      Partials.Channel,
      Partials.Message
    ]
  });

  client.once('ready', () => {
    console.log(`🤖 Discord Bot online với tên: ${client.user.tag}`);
  });

  // Lắng nghe nút tương tác (Buttons) từ Admin
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;

    // 1. Thao tác Toggle Mode
    if (customId === 'set_dev_mode') {
      await interaction.deferReply();
      const instanceId = process.env.EC2_INSTANCE_ID;
      try {
        await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py dev || sudo touch /opt/mc-autoshutdown/DEV_MODE');
        const devEmbed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('🛠️ Chế độ Server: DEV MODE')
          .setDescription('Đã kích hoạt **DEV MODE** thành công!\n\n📌 **Lưu ý:** Server EC2 sẽ **KHÔNG** tự động tắt dù 0 có người chơi online.')
          .setTimestamp();
        await interaction.editReply({ embeds: [devEmbed], components: [getModeActionRow()] });
      } catch (err) {
        await interaction.editReply({ content: `❌ Lỗi khi bật Dev Mode: ${err.message}` });
      }
      return;
    }

    if (customId === 'set_normal_mode') {
      await interaction.deferReply();
      const instanceId = process.env.EC2_INSTANCE_ID;
      try {
        await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py normal || sudo rm -f /opt/mc-autoshutdown/DEV_MODE');
        const normalEmbed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('🟢 Chế độ Server: NORMAL MODE')
          .setDescription('Đã kích hoạt **NORMAL MODE** thành công!\n\n📌 **Lưu ý:** Server EC2 sẽ **tự động tắt sau 30 phút** nếu không có người chơi nào online.')
          .setTimestamp();
        await interaction.editReply({ embeds: [normalEmbed], components: [getModeActionRow()] });
      } catch (err) {
        await interaction.editReply({ content: `❌ Lỗi khi bật Normal Mode: ${err.message}` });
      }
      return;
    }

    // 2. Thao tác Duyệt / Từ chối Bật Server
    if (!customId.startsWith('approve_mc_') && !customId.startsWith('reject_mc_')) return;

    const isApprove = customId.startsWith('approve_mc_');
    const reqId = customId.replace('approve_mc_', '').replace('reject_mc_', '');

    const requestData = pendingRequests.get(reqId);
    if (!requestData) {
      return interaction.reply({ 
        content: '⚠️ Yêu cầu này đã hết hạn hoặc không còn tồn tại.', 
        ephemeral: true 
      });
    }

    // Xóa bộ đếm 10 phút vì Admin đã thao tác
    clearTimeout(requestData.timer);
    pendingRequests.delete(reqId);

    const adminUser = interaction.user.tag;

    if (isApprove) {
      await interaction.deferUpdate();

      // Cập nhật Embed thành màu Xanh (Đã duyệt)
      const approvedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0x2ecc71)
        .setTitle('✅ Yêu cầu BẬT Minecraft Server đã ĐƯỢC CHẤP NHẬN')
        .setDescription(`Admin **${adminUser}** đã phê duyệt yêu cầu!\nHệ thống đang khởi động Minecraft Server...`)
        .setFields(
          { name: 'Trạng thái', value: '🟢 Đã kích hoạt lệnh khởi động', inline: true },
          { name: 'Thời gian duyệt', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
        );

      await interaction.editReply({ embeds: [approvedEmbed], components: [] });

      // Gọi PufferPanel API hoặc AWS SSM Command
      try {
        const instanceId = process.env.EC2_INSTANCE_ID;
        const pufferServerId = process.env.PUFFER_SERVER_ID;
        const pufferClientId = process.env.PUFFER_CLIENT_ID;
        const pufferClientSecret = process.env.PUFFER_CLIENT_SECRET;
        const pufferPort = process.env.PUFFER_PORT || '8080';

        if (pufferServerId && pufferClientId && pufferClientSecret) {
          console.log('🎮 Phát hiện cấu hình PufferPanel! Đang kích hoạt qua PufferPanel API...');
          
          // Chạy lệnh curl PufferPanel API trực tiếp trên VPS qua SSM
          const ssmPufferCmd = generatePufferPanelSSMCommand(
            pufferServerId, 
            pufferClientId, 
            pufferClientSecret, 
            pufferPort
          );
          
          await runSSMStartMinecraftCommand(instanceId, ssmPufferCmd);
        } else {
          // Fallback sang lệnh Shell thông thường nếu không dùng PufferPanel
          const mcCommand = process.env.MC_START_COMMAND || 'sudo systemctl start minecraft';
          await runSSMStartMinecraftCommand(instanceId, mcCommand);
        }
        
        requestData.resolve({ status: 'approved', admin: adminUser });
      } catch (err) {
        console.error('Lỗi khi kích hoạt Minecraft Server:', err);
        requestData.reject(err);
      }

      // Xóa tin nhắn Discord sau 10 giây để giữ DM gọn gàng
      setTimeout(() => {
        interaction.message.delete().catch(() => {});
      }, 10000);

    } else {
      await interaction.deferUpdate();

      // Cập nhật Embed thành màu Đỏ (Từ chối)
      const rejectedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0xe74c3c)
        .setTitle('❌ Yêu cầu BẬT Minecraft Server bị TỪ CHỐI')
        .setDescription(`Admin **${adminUser}** đã từ chối yêu cầu bật server.`)
        .setFields(
          { name: 'Trạng thái', value: '🔴 Đã từ chối', inline: true },
          { name: 'Thời gian', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
        );

      await interaction.editReply({ embeds: [rejectedEmbed], components: [] });

      requestData.resolve({ status: 'rejected', admin: adminUser });

      // Xóa tin nhắn Discord sau 5 giây
      setTimeout(() => {
        interaction.message.delete().catch(() => {});
      }, 5000);
    }
  });

  // Lắng nghe tin nhắn văn bản (Message Command) từ Admin
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const adminId = process.env.DISCORD_ADMIN_ID;
    if (adminId && message.author.id !== adminId.trim()) return;

    const content = message.content.trim().toLowerCase();

    // Menu trợ giúp / điều khiển mode
    if (['!mode', '!dev', '!help', '!server'].includes(content)) {
      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('⚙️ Quản lý Chế độ Server (Auto-Shutdown Control)')
        .setDescription('Chọn chế độ hoạt động cho Server Minecraft:')
        .addFields(
          { name: '🛠️ Dev Mode (`!dev on` hoặc `!mode dev`)', value: 'Vô hiệu hóa tự động tắt VPS EC2. Server sẽ chạy liên tục để dev/test.', inline: false },
          { name: '🟢 Normal Mode (`!dev off` hoặc `!mode normal`)', value: 'Bật tự động tắt VPS EC2 sau 30 phút 0 người chơi (Tiết kiệm chi phí AWS).', inline: false }
        )
        .setFooter({ text: 'Gõ !dev on / !dev off hoặc bấm nút bên dưới' });

      return message.reply({ embeds: [embed], components: [getModeActionRow()] });
    }

    // Lệnh nhanh: Bật Dev Mode
    if (['!mode dev', '!dev on', '!mode devmode'].includes(content)) {
      const instanceId = process.env.EC2_INSTANCE_ID;
      try {
        await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py dev || sudo touch /opt/mc-autoshutdown/DEV_MODE');
        const devEmbed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('🛠️ Đã chuyển sang DEV MODE!')
          .setDescription('Tính năng tự động tắt server đã **VÔ HIỆU HÓA**.\nServer EC2 sẽ giữ trạng thái hoạt động liên tục.')
          .setTimestamp();
        return message.reply({ embeds: [devEmbed], components: [getModeActionRow()] });
      } catch (err) {
        return message.reply(`❌ Lỗi khi kích hoạt Dev Mode: ${err.message}`);
      }
    }

    // Lệnh nhanh: Bật Normal Mode
    if (['!mode normal', '!dev off', '!mode normalmode'].includes(content)) {
      const instanceId = process.env.EC2_INSTANCE_ID;
      try {
        await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py normal || sudo rm -f /opt/mc-autoshutdown/DEV_MODE');
        const normalEmbed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('🟢 Đã chuyển sang NORMAL MODE!')
          .setDescription('Tính năng tự động tắt server đã **KÍCH HOẠT**.\nServer EC2 sẽ tự động tắt sau 30 phút không có người chơi online.')
          .setTimestamp();
        return message.reply({ embeds: [normalEmbed], components: [getModeActionRow()] });
      } catch (err) {
        return message.reply(`❌ Lỗi khi kích hoạt Normal Mode: ${err.message}`);
      }
    }
  });

  client.login(token).catch(err => {
    console.error('❌ Không thể đăng nhập Discord Bot:', err.message);
  });
}

/**
 * Gửi yêu cầu Embed kèm 2 Nút Accept/Reject trực tiếp qua Tin Nhắn Riêng (DM) cho Admin
 */
async function sendMinecraftStartRequest({ requesterIp, publicIp }) {
  if (!client || !client.isReady()) {
    throw new Error('Discord Bot chưa sẵn sàng hoặc chưa cấu hình DISCORD_BOT_TOKEN.');
  }

  const adminId = process.env.DISCORD_ADMIN_ID;
  if (!adminId || !adminId.trim() || adminId.includes('XXXXXX')) {
    throw new Error('Chưa cấu hình DISCORD_ADMIN_ID trong file .env. Vui lòng bật Developer Mode trên Discord, chuột phải vào tên/avatar của bạn -> Chọn "Copy User ID" và dán vào DISCORD_ADMIN_ID trong file .env.');
  }

  // Tìm người dùng Admin qua Discord User ID
  const adminUser = await client.users.fetch(adminId).catch(() => null);
  if (!adminUser) {
    throw new Error(`Không tìm thấy người dùng Discord với ID: ${adminId}. Vui lòng kiểm tra lại DISCORD_ADMIN_ID.`);
  }

  const reqId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🎮 Yêu cầu Bật Minecraft Server (PufferPanel / EC2)')
    .setDescription(`Một người dùng trên Website đang yêu cầu bật Minecraft Server!`)
    .addFields(
      { name: '🌐 EC2 IP', value: `\`${publicIp || 'Unknown'}\``, inline: true },
      { name: '👤 IP Người yêu cầu', value: `\`${requesterIp}\``, inline: true },
      { name: '⚙️ Quản lý qua', value: process.env.PUFFER_SERVER_ID ? 'PufferPanel API' : 'Direct Script', inline: true },
      { name: '⏳ Hạn phản hồi', value: '10 phút (Tự động hủy nếu không bấm)', inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'On-Demand EC2 Minecraft System' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_mc_${reqId}`)
      .setLabel('Chấp nhận (Start Server)')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`reject_mc_${reqId}`)
      .setLabel('Từ chối')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('✖️')
  );

  // Gửi tin nhắn riêng (DM) tới Admin
  let message;
  try {
    message = await adminUser.send({
      content: `🔔 Có yêu cầu bật Minecraft Server mới!`,
      embeds: [embed],
      components: [row]
    });
  } catch (dmErr) {
    console.error('Lỗi khi gửi tin nhắn riêng DM cho Admin:', dmErr);
    throw new Error(`Không thể gửi tin nhắn riêng (DM) tới Admin: ${dmErr.message}. Vui lòng đảm bảo Bot và Admin ở chung ít nhất 1 Server Discord và Admin không bật tính năng chặn DM từ Bot.`);
  }

  return new Promise((resolve, reject) => {
    // Cài đặt timeout 10 phút (600,000 ms)
    const timer = setTimeout(async () => {
      pendingRequests.delete(reqId);

      const expiredEmbed = EmbedBuilder.from(message.embeds[0])
        .setColor(0x7f8c8d)
        .setTitle('⏰ Yêu cầu BẬT Minecraft Server đã HẾT HẠN')
        .setDescription('Không có phản hồi từ Admin sau 10 phút. Yêu cầu đã tự động hủy.')
        .setFields({ name: 'Trạng thái', value: '⚪ Hết hạn (Expired)', inline: true });

      await message.edit({ embeds: [expiredEmbed], components: [] }).catch(() => {});

      setTimeout(() => {
        message.delete().catch(() => {});
      }, 5000);

      resolve({ status: 'timeout' });
    }, 10 * 60 * 1000);

    pendingRequests.set(reqId, { resolve, reject, message, timer });
  });
}

module.exports = {
  initDiscordBot,
  sendMinecraftStartRequest
};


