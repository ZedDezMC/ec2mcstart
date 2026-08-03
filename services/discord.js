const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const { getInstanceStatus, startInstance, stopInstance, runSSMStartMinecraftCommand } = require('./aws');
const { checkMinecraftServerStatus } = require('./minecraft');
const { generatePufferPanelSSMCommand } = require('./pufferpanel');

let client = null;
const pendingRequests = new Map(); // reqId -> { resolve, reject, message, timer }

/**
 * Kiểm tra xem người dùng có quyền Admin hoặc có Role ID được phép hay không
 */
function isAuthorized(member, user) {
  const adminId = (process.env.DISCORD_ADMIN_ID || '').trim();
  const allowedRoleId = (process.env.DISCORD_ADMIN_ROLE_ID || '1225455630014480404').trim();

  // 1. Kiểm tra User ID trực tiếp của Admin
  if (adminId && !adminId.includes('XXXXXX') && user && user.id === adminId) {
    return true;
  }

  // 2. Kiểm tra nếu người dùng sở hữu Role ID (1225455630014480404)
  if (member && member.roles) {
    if (member.roles.cache && typeof member.roles.cache.has === 'function') {
      if (member.roles.cache.has(allowedRoleId)) {
        return true;
      }
    }
    if (Array.isArray(member.roles) && member.roles.includes(allowedRoleId)) {
      return true;
    }
  }

  // 3. Nếu chưa cấu hình DISCORD_ADMIN_ID -> Tạm thời mở quyền
  if (!adminId || adminId.includes('XXXXXX')) {
    return true;
  }

  return false;
}

/**
 * Tạo Hàng Nút Bấm Điều Khiển (Interactive Dashboard Action Rows)
 */
function getDashboardActionRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('start_server')
      .setLabel('Start EC2 & MC')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('stop_server')
      .setLabel('Stop EC2 & MC')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('restart_server')
      .setLabel('Restart MC')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('refresh_status')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('set_dev_mode')
      .setLabel('Dev Mode')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('set_normal_mode')
      .setLabel('Normal Mode')
      .setStyle(ButtonStyle.Success)
  );

  return [row1, row2];
}

/**
 * Tạo Embed Trạng Thái Hệ Thống Realtime
 */
async function buildStatusEmbed() {
  const instanceId = process.env.EC2_INSTANCE_ID;
  const mcPort = parseInt(process.env.MC_PORT || '25565', 10);
  const customAddress = (process.env.CUSTOM_SERVER_ADDRESS || '').trim();

  let ec2State = 'Unknown';
  let publicIp = null;
  let mcOnline = false;

  if (instanceId && !instanceId.includes('i-0123456789')) {
    try {
      const status = await getInstanceStatus(instanceId);
      ec2State = status.state;
      publicIp = status.publicIp;

      if (ec2State === 'running' && publicIp) {
        mcOnline = await checkMinecraftServerStatus(publicIp, mcPort);
      }
    } catch (err) {
      console.error('error fetch status:', err.message);
    }
  }

  let serverAddress = customAddress || (publicIp ? `${publicIp}:${mcPort}` : 'N/A');

  // Xác định màu sắc Embed
  let embedColor = 0x7f8c8d; // Xám (Offline)
  if (ec2State === 'running' && mcOnline) {
    embedColor = 0x2ecc71; // Xanh lá (Online hoàn toàn)
  } else if (ec2State === 'running' || ec2State === 'pending') {
    embedColor = 0xf1c40f; // Vàng (Đang khởi động / Khác)
  }

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('Dashboard Quan Ly Server Minecraft & AWS EC2')
    .setDescription('Làm bởi hsowndev - phục vụ riêng cho server Discord Động Chim Giấy')
    .addFields(
      { name: 'VPS Status', value: `\`${ec2State.toUpperCase()}\``, inline: true },
      { name: 'Minecraft Server', value: mcOnline ? '`ONLINE`' : '`OFFLINE`', inline: true },
      { name: 'Public IP', value: `\`${publicIp || 'Offline'}\``, inline: true },
      { name: 'Server Address', value: `\`${serverAddress}\``, inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'hsowndev - Động Chim Giấy' });

  return embed;
}

/**
 * Đăng ký Slash Commands với Discord API
 */
async function registerSlashCommands(clientId, token) {
  const commands = [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Kiểm tra trạng thái VPS và Minecraft Server'),
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Hiện dashboard điều khiển'),
    new SlashCommandBuilder()
      .setName('start')
      .setDescription('Khởi động VPS và Minecraft Server'),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Tắt Minecraft Server và VPS'),
    new SlashCommandBuilder()
      .setName('restart')
      .setDescription('Khởi động lại Minecraft Server'),
    new SlashCommandBuilder()
      .setName('mode')
      .setDescription('Đổi mode (Dev Mode / Normal Mode)')
      .addStringOption(option =>
        option.setName('type')
          .setDescription('Loại chế độ')
          .setRequired(true)
          .addChoices(
            { name: 'Dev Mode (24/7)', value: 'dev' },
            { name: 'Normal Mode (Tự tắt sau 30p)', value: 'normal' }
          )
      ),
    new SlashCommandBuilder()
      .setName('cmd')
      .setDescription('Gửi lệnh tới Server Minecraft')
      .addStringOption(option =>
        option.setName('command')
          .setDescription('Lệnh cần dùng')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Xem hướng dẫn sử dụng')
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log('[Discord Bot] Đang đăng ký lệnh...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('[Discord Bot] Đăng ký lệnh thành công!');
  } catch (error) {
    console.error('[Discord Bot] Lỗi khi đăng ký lệnh:', error);
  }
}

/**
 * Khởi tạo Discord Bot Client
 */
function initDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || token.includes('XXXXXX')) {
    console.warn('[Discord Bot] Chưa cấu hình token');
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

  client.once('ready', async () => {
    console.log(`[Discord Bot] Đã online với tên: ${client.user.tag}`);
    // Đăng ký Slash Commands khi Bot ready
    registerSlashCommands(client.user.id, token);
  });

  // 1. Xử lý Interaction (Buttons & Slash Commands)
  client.on('interactionCreate', async (interaction) => {
    // --------------------------------------------------
    // A. XỬ LÝ SLASH COMMANDS (`/`)
    // --------------------------------------------------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (!isAuthorized(interaction.member, interaction.user)) {
        return interaction.reply({
          content: '[DENIED] Hiện tại không có quyền để thực thi lệnh này.',
          ephemeral: true
        });
      }

      const instanceId = process.env.EC2_INSTANCE_ID;

      if (commandName === 'status') {
        await interaction.deferReply();
        const embed = await buildStatusEmbed();
        return interaction.editReply({ embeds: [embed], components: getDashboardActionRows() });
      }

      if (commandName === 'panel') {
        await interaction.deferReply();
        const embed = await buildStatusEmbed();
        return interaction.editReply({ embeds: [embed], components: getDashboardActionRows() });
      }

      if (commandName === 'start') {
        await interaction.deferReply();
        try {
          const res = await startInstance(instanceId);
          const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('[START] Dang khoi dong VPS...')
            .setDescription(`Đã gửi lệnh bật VPS (${instanceId}).\nTrạng thái trước đó: \`${res.previousState}\` -> Trạng thái hiện tại: \`${res.currentState}\`.\nVui lòng chờ khoảng 30-60 giây để hoàn thành thao tác.`)
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        } catch (err) {
          return interaction.editReply({ content: `[ERROR] Không thể khởi động VPS: ${err.message}` });
        }
      }

      if (commandName === 'stop') {
        await interaction.deferReply();
        try {
          // Gửi lệnh save-all trước khi stop VPS
          try {
            await runSSMStartMinecraftCommand(instanceId, 'sudo systemctl stop minecraft || true');
          } catch (e) { }

          const res = await stopInstance(instanceId);
          const embed = new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('[STOP] Dang tat VPS...')
            .setDescription(`Đã gửi lệnh tắt VPS (${instanceId}).\nTrạng thái trước đó: \`${res.previousState}\` -> Trạng thái hiện tại: \`${res.currentState}\`.`)
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        } catch (err) {
          return interaction.editReply({ content: `[ERROR] Không thể tắt VPS: ${err.message}` });
        }
      }

      if (commandName === 'restart') {
        await interaction.deferReply();
        try {
          const pufferServerId = process.env.PUFFER_SERVER_ID;
          if (pufferServerId && process.env.PUFFER_CLIENT_ID) {
            const ssmPufferCmd = generatePufferPanelSSMCommand(
              pufferServerId,
              process.env.PUFFER_CLIENT_ID,
              process.env.PUFFER_CLIENT_SECRET,
              process.env.PUFFER_PORT || '8080'
            );
            await runSSMStartMinecraftCommand(instanceId, ssmPufferCmd);
          } else {
            const mcCmd = process.env.MC_START_COMMAND || 'sudo systemctl restart minecraft';
            await runSSMStartMinecraftCommand(instanceId, mcCmd);
          }
          return interaction.editReply({ content: '[SUCCESS] Đã gửi lệnh Restart Minecraft Server!' });
        } catch (err) {
          return interaction.editReply({ content: `[ERROR] Không thể restart Minecraft Server: ${err.message}` });
        }
      }

      if (commandName === 'mode') {
        await interaction.deferReply();
        const modeType = interaction.options.getString('type');
        if (modeType === 'dev') {
          try {
            await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py dev || sudo touch /opt/mc-autoshutdown/DEV_MODE');
            return interaction.editReply({ content: '[DEV MODE] Đã chuyển sang DEV MODE' });
          } catch (err) {
            return interaction.editReply({ content: `[ERROR] Lỗi khi bật Dev Mode: ${err.message}` });
          }
        } else {
          try {
            await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py normal || sudo rm -f /opt/mc-autoshutdown/DEV_MODE');
            return interaction.editReply({ content: '[NORMAL MODE] Đã chuyển sang NORMAL MODE' });
          } catch (err) {
            return interaction.editReply({ content: `[ERROR] Lỗi khi bật Normal Mode: ${err.message}` });
          }
        }
      }

      if (commandName === 'cmd') {
        await interaction.deferReply();
        const shellCmd = interaction.options.getString('command');
        try {
          await runSSMStartMinecraftCommand(instanceId, shellCmd);
          return interaction.editReply({ content: `[EXEC] Đã gửi lệnh:\n\`\`\`bash\n${shellCmd}\n\`\`\`` });
        } catch (err) {
          return interaction.editReply({ content: `[ERROR] Lỗi khi gửi lệnh: ${err.message}` });
        }
      }

      if (commandName === 'help') {
        const helpEmbed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('Tro giup')
          .setDescription('Danh sách các lệnh:')
          .addFields(
            { name: '`/status` hoặc `!status`', value: 'Xem trạng thái VPS EC2 và Minecraft Server realtime.', inline: false },
            { name: '`/panel` hoặc `!panel`', value: 'Mở Bảng điều khiển Dashboard trực quan dạng nút bấm.', inline: false },
            { name: '`/start` hoặc `!start`', value: 'Khởi động VPS EC2 và Minecraft Server.', inline: false },
            { name: '`/stop` hoặc `!stop`', value: 'Tắt Minecraft Server an toàn và ngắt VPS EC2.', inline: false },
            { name: '`/restart` hoặc `!restart`', value: 'Khởi động lại Minecraft Server.', inline: false },
            { name: '`/mode dev` hoặc `!dev on`', value: 'Bật Dev Mode (Server chạy 24/7).', inline: false },
            { name: '`/mode normal` hoặc `!dev off`', value: 'Bật Normal Mode (Tự động tắt sau 30p 0 người chơi).', inline: false },
            { name: '`/cmd <lệnh>` hoặc `!cmd <lệnh>`', value: 'Gửi lệnh trực tiếp vào VPS.', inline: false }
          );
        return interaction.reply({ embeds: [helpEmbed] });
      }
    }

    // --------------------------------------------------
    // B. XỬ LÝ ACTION BUTTONS (Nút Bấm Trực Quan)
    // --------------------------------------------------
    if (interaction.isButton()) {
      if (!isAuthorized(interaction.member, interaction.user)) {
        return interaction.reply({
          content: '[DENIED] Hiện tại không có quyền để thực thi hành động này.',
          ephemeral: true
        });
      }

      const customId = interaction.customId;
      const instanceId = process.env.EC2_INSTANCE_ID;

      // 1. Refresh Status
      if (customId === 'refresh_status') {
        await interaction.deferUpdate();
        const embed = await buildStatusEmbed();
        return interaction.editReply({ embeds: [embed], components: getDashboardActionRows() });
      }

      // 2. Start EC2 & MC
      if (customId === 'start_server') {
        await interaction.deferReply({ ephemeral: true });
        try {
          const res = await startInstance(instanceId);
          return interaction.editReply({ content: `[START] Đã gửi lệnh bật VPS! Status: \`${res.currentState}\`. Vui lòng chờ 30-60s.` });
        } catch (err) {
          return interaction.editReply({ content: `[ERROR] Lỗi khi bật VPS: ${err.message}` });
        }
      }

      // 3. Stop EC2 & MC
      if (customId === 'stop_server') {
        await interaction.deferReply({ ephemeral: true });
        try {
          await stopInstance(instanceId);
          return interaction.editReply({ content: '[STOP] Đã gửi lệnh tắt VPS thành công!' });
        } catch (err) {
          return interaction.editReply({ content: `[ERROR] Lỗi khi tắt VPS: ${err.message}` });
        }
      }

      // 4. Restart MC
      if (customId === 'restart_server') {
        await interaction.deferReply({ ephemeral: true });
        try {
          const mcCmd = process.env.MC_START_COMMAND || 'sudo systemctl restart minecraft';
          await runSSMStartMinecraftCommand(instanceId, mcCmd);
          return interaction.editReply({ content: '[RESTART] Đã gửi lệnh Restart Minecraft Server!' });
        } catch (err) {
          return interaction.editReply({ content: `[ERROR] Lỗi khi Restart: ${err.message}` });
        }
      }

      // 5. Dev Mode
      if (customId === 'set_dev_mode') {
        await interaction.deferReply({ ephemeral: true });
        try {
          await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py dev || sudo touch /opt/mc-autoshutdown/DEV_MODE');
          return interaction.editReply({ content: '[DEV MODE] Đã kích hoạt DEV MODE thành công' });
        } catch (err) {
          return interaction.editReply({ content: `[ERROR] Lỗi khi bật Dev Mode: ${err.message}` });
        }
      }

      // 6. Normal Mode
      if (customId === 'set_normal_mode') {
        await interaction.deferReply({ ephemeral: true });
        try {
          await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py normal || sudo rm -f /opt/mc-autoshutdown/DEV_MODE');
          return interaction.editReply({ content: '[NORMAL MODE] Đã kích hoạt NORMAL MODE thành công' });
        } catch (err) {
          return interaction.editReply({ content: `[ERROR] Lỗi khi bật Normal Mode: ${err.message}` });
        }
      }

      // 7. Request Approve/Reject Handle
      if (customId.startsWith('approve_mc_') || customId.startsWith('reject_mc_')) {
        const isApprove = customId.startsWith('approve_mc_');
        const reqId = customId.replace('approve_mc_', '').replace('reject_mc_', '');
        const requestData = pendingRequests.get(reqId);

        if (!requestData) {
          return interaction.reply({ content: '[WARN] Yêu cầu này đã hết hạn.', ephemeral: true });
        }

        clearTimeout(requestData.timer);
        pendingRequests.delete(reqId);
        const adminUser = interaction.user.tag;

        if (isApprove) {
          await interaction.deferUpdate();
          const approvedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0x2ecc71)
            .setTitle('[APPROVED] Yeu cau BAT Minecraft Server da DUOC CHAP NHAN')
            .setDescription(`Admin **${adminUser}** đã phê duyệt yêu cầu!`);
          await interaction.editReply({ embeds: [approvedEmbed], components: [] });

          try {
            const pufferServerId = process.env.PUFFER_SERVER_ID;
            if (pufferServerId && process.env.PUFFER_CLIENT_ID) {
              const ssmPufferCmd = generatePufferPanelSSMCommand(
                pufferServerId,
                process.env.PUFFER_CLIENT_ID,
                process.env.PUFFER_CLIENT_SECRET,
                process.env.PUFFER_PORT || '8080'
              );
              await runSSMStartMinecraftCommand(instanceId, ssmPufferCmd);
            } else {
              const mcCommand = process.env.MC_START_COMMAND || 'sudo systemctl start minecraft';
              await runSSMStartMinecraftCommand(instanceId, mcCommand);
            }
            requestData.resolve({ status: 'approved', admin: adminUser });
          } catch (err) {
            requestData.reject(err);
          }
        } else {
          await interaction.deferUpdate();
          const rejectedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0xe74c3c)
            .setTitle('[REJECTED] Yeu cau BAT Minecraft Server bi TU CHOI')
            .setDescription(`Admin **${adminUser}** đã từ chối yêu cầu.`);
          await interaction.editReply({ embeds: [rejectedEmbed], components: [] });
          requestData.resolve({ status: 'rejected', admin: adminUser });
        }
      }
    }
  });

  // 2. Lắng nghe tin nhắn văn bản Prefix (`!`) từ Admin
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!isAuthorized(message.member, message.author)) return;

    const content = message.content.trim();
    const lowerContent = content.toLowerCase();
    const instanceId = process.env.EC2_INSTANCE_ID;

    // Status / Panel / Admin
    if (['!status', '!panel', '!admin'].includes(lowerContent)) {
      const embed = await buildStatusEmbed();
      return message.reply({ embeds: [embed], components: getDashboardActionRows() });
    }

    // Help
    if (['!help', '!h'].includes(lowerContent)) {
      const helpEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('Tro giup')
        .setDescription('Các câu lệnh dạng Prefix (`!`):')
        .addFields(
          { name: '`!status` / `!panel`', value: 'Mở Dashboard điều khiển trực quan.', inline: false },
          { name: '`!start`', value: 'Bật VPS và Minecraft Server.', inline: false },
          { name: '`!stop`', value: 'Tắt Minecraft Server và ngắt VPS.', inline: false },
          { name: '`!restart`', value: 'Khởi động lại Minecraft Server.', inline: false },
          { name: '`!dev on` / `!mode dev`', value: 'Bật Dev Mode.', inline: false },
          { name: '`!dev off` / `!mode normal`', value: 'Bật Normal Mode.', inline: false },
          { name: '`!cmd <lệnh>`', value: 'Gửi lệnh trực tiếp sang VPS.', inline: false }
        );
      return message.reply({ embeds: [helpEmbed] });
    }

    // Start
    if (lowerContent === '!start') {
      try {
        const res = await startInstance(instanceId);
        return message.reply(`[START] Đã gửi lệnh bật VPS (${instanceId})! Status: \`${res.currentState}\`.`);
      } catch (err) {
        return message.reply(`[ERROR] Không thể bật VPS: ${err.message}`);
      }
    }

    // Stop
    if (lowerContent === '!stop') {
      try {
        await stopInstance(instanceId);
        return message.reply(`[STOP] Đã gửi lệnh tắt VPS (${instanceId})!`);
      } catch (err) {
        return message.reply(`[ERROR] Không thể tắt VPS: ${err.message}`);
      }
    }

    // Restart
    if (lowerContent === '!restart') {
      try {
        const mcCmd = process.env.MC_START_COMMAND || 'sudo systemctl restart minecraft';
        await runSSMStartMinecraftCommand(instanceId, mcCmd);
        return message.reply('[RESTART] Đã gửi lệnh Restart Minecraft Server!');
      } catch (err) {
        return message.reply(`[ERROR] Không thể Restart: ${err.message}`);
      }
    }

    // Dev Mode
    if (['!mode dev', '!dev on', '!mode devmode'].includes(lowerContent)) {
      try {
        await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py dev || sudo touch /opt/mc-autoshutdown/DEV_MODE');
        return message.reply('[DEV MODE] Đã chuyển sang DEV MODE');
      } catch (err) {
        return message.reply(`[ERROR] Lỗi khi bật Dev Mode: ${err.message}`);
      }
    }

    // Normal Mode
    if (['!mode normal', '!dev off', '!mode normalmode'].includes(lowerContent)) {
      try {
        await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py normal || sudo rm -f /opt/mc-autoshutdown/DEV_MODE');
        return message.reply('[NORMAL MODE] Đã chuyển sang NORMAL MODE');
      } catch (err) {
        return message.reply(`[ERROR] Lỗi khi bật Normal Mode: ${err.message}`);
      }
    }

    // Direct SSM Command: !cmd <command>
    if (lowerContent.startsWith('!cmd ')) {
      const shellCmd = content.substring(5).trim();
      try {
        await runSSMStartMinecraftCommand(instanceId, shellCmd);
        return message.reply(`[EXEC] Đã gửi lệnh:\n\`\`\`bash\n${shellCmd}\n\`\`\``);
      } catch (err) {
        return message.reply(`[ERROR] Lỗi gửi lệnh: ${err.message}`);
      }
    }
  });

  client.login(token).catch(err => {
    console.error('[Discord Bot] Không thể đăng nhập Discord Bot:', err.message);
  });
}

/**
 * Gửi yêu cầu Embed kèm 2 Nút Accept/Reject trực tiếp qua Tin Nhắn Riêng (DM) cho Admin
 */
async function sendMinecraftStartRequest({ requesterIp, publicIp }) {
  if (!client || !client.isReady()) {
    throw new Error('Discord Bot chưa sẵn sàng hoặc chưa cấu hình token.');
  }

  const adminId = process.env.DISCORD_ADMIN_ID;
  if (!adminId || !adminId.trim() || adminId.includes('XXXXXX')) {
    throw new Error('Chưa cấu hình id trong file .env.');
  }

  const adminUser = await client.users.fetch(adminId).catch(() => null);
  if (!adminUser) {
    throw new Error(`Không tìm thấy người dùng Discord với ID: ${adminId}.`);
  }

  const reqId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('[REQUEST] Yeu cau Bat Minecraft Server')
    .setDescription(`Có người đang yêu cầu bật Minecraft Server`)
    .addFields(
      { name: 'IP VPS', value: `\`${publicIp || 'Unknown'}\``, inline: true },
      { name: 'IP Nguoi yeu cau', value: `\`${requesterIp}\``, inline: true },
      { name: 'Quan ly qua', value: process.env.PUFFER_SERVER_ID ? 'PufferPanel API' : 'Direct Script', inline: true },
      { name: 'Han phan hoi', value: '10 phút', inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'hsowndev - Động Chim Giấy' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_mc_${reqId}`)
      .setLabel('Chap nhan')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject_mc_${reqId}`)
      .setLabel('Tu choi')
      .setStyle(ButtonStyle.Danger)
  );

  let message;
  try {
    message = await adminUser.send({
      content: `[NOTIFICATION] Co yeu cau bat Minecraft Server moi!`,
      embeds: [embed],
      components: [row]
    });
  } catch (dmErr) {
    console.error('Lỗi khi gửi tin nhắn:', dmErr);
    throw new Error(`Không thể gửi tin nhắn tới Admin: ${dmErr.message}.`);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      pendingRequests.delete(reqId);
      const expiredEmbed = EmbedBuilder.from(message.embeds[0])
        .setColor(0x7f8c8d)
        .setTitle('[EXPIRED] Yeu cau BAT Minecraft Server da HET HAN')
        .setDescription('Không có phản hồi từ Admin.');
      await message.edit({ embeds: [expiredEmbed], components: [] }).catch(() => { });
      setTimeout(() => message.delete().catch(() => { }), 5000);
      resolve({ status: 'timeout' });
    }, 10 * 60 * 1000);

    pendingRequests.set(reqId, { resolve, reject, message, timer });
  });
}

module.exports = {
  initDiscordBot,
  sendMinecraftStartRequest
};
