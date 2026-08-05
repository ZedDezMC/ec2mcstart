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

const { getInstanceStatus, startInstance, stopInstance, rebootInstance, runSSMStartMinecraftCommand } = require('./aws');
const { checkMinecraftServerStatus, sendMinecraftRconCommand } = require('./minecraft');
const { generatePufferPanelSSMCommand } = require('./pufferpanel');

let client = null;
const pendingRequests = new Map(); // reqId -> { resolve, reject, message, timer }
let currentMode = 'normal'; // Mode hiện tại: 'normal' hoặc 'dev'

/**
 * Kiểm tra xem người dùng có quyền Admin hoặc có Role ID được phép hay không
 */
function isAuthorized(member, user) {
  const adminId = (process.env.DISCORD_ADMIN_ID || '').trim();
  const allowedRoleId = (process.env.DISCORD_ADMIN_ROLE_ID || '1225455630014480404').trim();
  const extraBypassRoleId = '1531664569590616205';

  // 1. Kiểm tra User ID trực tiếp của Admin
  if (adminId && !adminId.includes('XXXXXX') && user && user.id === adminId) {
    return true;
  }

  // 2. Kiểm tra nếu người dùng sở hữu Role ID admin hoặc role 1531664569590616205
  if (member && member.roles) {
    if (member.roles.cache && typeof member.roles.cache.has === 'function') {
      if (member.roles.cache.has(allowedRoleId) || member.roles.cache.has(extraBypassRoleId)) {
        return true;
      }
    }
    if (Array.isArray(member.roles) && (member.roles.includes(allowedRoleId) || member.roles.includes(extraBypassRoleId))) {
      return true;
    }
  }

  // 3. Nếu chưa cấu hình DISCORD_ADMIN_ID -> Tạm thời mở quyền
  if (!adminId || adminId.includes('XXXXXX')) {
    return true;
  }

  return false;
}

const ALLOWED_CHANNELS = ['1273063048520667217', '1531664569590616205'];

/**
 * Kiểm tra xem kênh hiện tại người dùng có được phép thực thi lệnh hay không
 */
function isChannelAllowed(channelId, member, user) {
  // Người tạo bot / Admin / Role 1531664569590616205 được phép sử dụng ở MỌI kênh
  if (isAuthorized(member, user)) {
    return true;
  }
  // User thường chỉ được dùng ở 2 kênh 1273063048520667217 và 1531664569590616205
  return ALLOWED_CHANNELS.includes(channelId);
}

/**
 * Tự động xóa phản hồi tin nhắn văn bản sau 1 phút (60,000ms)
 */
async function sendAutoDeleteReply(message, options, delayMs = 60000) {
  try {
    const sentMsg = await message.reply(options);
    setTimeout(() => {
      sentMsg.delete().catch(() => { });
      message.delete().catch(() => { });
    }, delayMs);
    return sentMsg;
  } catch (err) {
    console.error('[Discord Bot Error] Không thể gửi/xóa tin nhắn:', err.message);
  }
}

/**
 * Tự động xóa phản hồi Interaction (Slash Command / Button) sau 1 phút (60,000ms)
 */
async function editReplyWithAutoDelete(interaction, options, delayMs = 60000) {
  try {
    const res = await interaction.editReply(options);
    setTimeout(() => {
      interaction.deleteReply().catch(() => { });
    }, delayMs);
    return res;
  } catch (err) {
    console.error('[Discord Bot Error] Không thể chỉnh sửa/xóa interaction reply:', err.message);
  }
}

/**
 * Tự động làm mới Embed dữ liệu mỗi 5s và xóa tin nhắn sau 5 phút (Interaction)
 */
async function startAutoRefreshInteractionPanel(interaction, refreshIntervalMs = 5000, totalDurationMs = 300000) {
  const { embed, ec2State } = await buildStatusEmbed();
  await interaction.editReply({ embeds: [embed], components: getDashboardActionRows(ec2State) });

  const startTime = Date.now();
  const intervalId = setInterval(async () => {
    if (Date.now() - startTime >= totalDurationMs) {
      clearInterval(intervalId);
      interaction.deleteReply().catch(() => { });
      return;
    }

    try {
      const { embed: updatedEmbed, ec2State: updatedState } = await buildStatusEmbed();
      await interaction.editReply({
        embeds: [updatedEmbed],
        components: getDashboardActionRows(updatedState)
      });
    } catch (err) {
      clearInterval(intervalId);
    }
  }, refreshIntervalMs);
}

/**
 * Tự động làm mới Embed dữ liệu mỗi 5s và xóa tin nhắn sau 5 phút (Message Prefix)
 */
async function startAutoRefreshMessagePanel(message, refreshIntervalMs = 5000, totalDurationMs = 300000) {
  const { embed, ec2State } = await buildStatusEmbed();
  const sentMsg = await message.reply({ embeds: [embed], components: getDashboardActionRows(ec2State) });

  const startTime = Date.now();
  const intervalId = setInterval(async () => {
    if (Date.now() - startTime >= totalDurationMs) {
      clearInterval(intervalId);
      sentMsg.delete().catch(() => { });
      message.delete().catch(() => { });
      return;
    }

    try {
      const { embed: updatedEmbed, ec2State: updatedState } = await buildStatusEmbed();
      await sentMsg.edit({
        embeds: [updatedEmbed],
        components: getDashboardActionRows(updatedState)
      });
    } catch (err) {
      clearInterval(intervalId);
    }
  }, refreshIntervalMs);
}

/**
 * Tạo Hàng Nút Bấm Điều Khiển Theo Trạng Thái & Chế Độ (Interactive Dashboard Action Rows)
 * @param {string} ec2State Trạng thái VPS ('stopped' | 'pending' | 'running' | 'stopping')
 * @param {string} mode Chế độ hiện tại ('normal' | 'dev')
 */
function getDashboardActionRows(ec2State, mode = currentMode) {
  const state = (ec2State || '').toLowerCase();

  const btnStart = new ButtonBuilder()
    .setCustomId('start_server')
    .setLabel('Start VPS & MC')
    .setStyle(ButtonStyle.Success);

  const btnRebootVPS = new ButtonBuilder()
    .setCustomId('reboot_vps')
    .setLabel('Restart VPS')
    .setStyle(ButtonStyle.Danger);

  const btnStop = new ButtonBuilder()
    .setCustomId('stop_server')
    .setLabel('Stop VPS & MC')
    .setStyle(ButtonStyle.Danger);

  const btnRestart = new ButtonBuilder()
    .setCustomId('restart_server')
    .setLabel('Restart MC')
    .setStyle(ButtonStyle.Secondary);

  const btnRefresh = new ButtonBuilder()
    .setCustomId('refresh_status')
    .setLabel('Refresh')
    .setStyle(ButtonStyle.Primary);

  const btnDevMode = new ButtonBuilder()
    .setCustomId('set_dev_mode')
    .setLabel('Dev Mode')
    .setStyle(ButtonStyle.Primary);

  const btnNormalMode = new ButtonBuilder()
    .setCustomId('set_normal_mode')
    .setLabel('Normal Mode')
    .setStyle(ButtonStyle.Success);

  // 1. stopped: chỉ hiện nút start và refresh
  if (state === 'stopped') {
    const row = new ActionRowBuilder().addComponents(btnStart, btnRefresh);
    return [row];
  }

  // 2. pending & stopping: chỉ hiện nút refresh
  if (state === 'pending' || state === 'stopping') {
    const row = new ActionRowBuilder().addComponents(btnRefresh);
    return [row];
  }

  // 3. running: hiện tất cả các nút
  if (state === 'running') {
    const row1 = new ActionRowBuilder().addComponents(btnStart, btnStop, btnRestart, btnRebootVPS);
    const row2 = new ActionRowBuilder().addComponents(
      btnRefresh,
      mode === 'dev' ? btnNormalMode : btnDevMode
    );
    return [row1, row2];
  }

  // Mặc định
  const defaultRow = new ActionRowBuilder().addComponents(btnStart, btnRefresh);
  return [defaultRow];
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
    .setTitle('Dashboard Quan Ly Server Minecraft & VPS')
    .setDescription('Làm bởi hsowndev - phục vụ riêng cho server Discord Động Chim Giấy')
    .addFields(
      { name: 'VPS Status', value: `\`${ec2State.toUpperCase()}\``, inline: true },
      { name: 'Minecraft Server', value: mcOnline ? '`ONLINE`' : '`OFFLINE`', inline: true },
      { name: 'Current Mode', value: currentMode === 'dev' ? '`DEV MODE (24/7)`' : '`NORMAL MODE (Auto-30m)`', inline: true },
      { name: 'Public IP', value: `\`${publicIp || 'Offline'}\``, inline: true },
      { name: 'Server Address', value: `\`${serverAddress}\``, inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'hsowndev - Động Chim Giấy' });

  return { embed, ec2State };
}

/**
 * Đăng ký Slash Commands với Discord API
 */
async function registerSlashCommands(clientId, token) {
  const commands = [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Kiểm tra trạng thái Server Minecraft'),
    new SlashCommandBuilder()
      .setName('startmc')
      .setDescription('Khởi động Server Minecraft (khi VPS đang chạy)'),
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
      .setName('rebootvps')
      .setDescription('Khởi động lại VPS'),
    new SlashCommandBuilder()
      .setName('mode')
      .setDescription('Đổi mode (Dev Mode / Normal Mode)')
      .addStringOption(option =>
        option.setName('type')
          .setDescription('Loại chế độ')
          .setRequired(true)
          .addChoices(
            { name: 'Dev Mode (Dùng khi cần restart server nhiều lần, cài & test plugin)', value: 'dev' },
            { name: 'Normal Mode (Tự tắt sau 30p)', value: 'normal' }
          )
      ),
    new SlashCommandBuilder()
      .setName('cmd')
      .setDescription('Gửi lệnh trực tiếp vào Console Server Minecraft')
      .addStringOption(option =>
        option.setName('command')
          .setDescription('Lệnh Minecraft cần dùng')
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

      // 1. Kiểm tra kênh được phép cho User thường
      if (!isChannelAllowed(interaction.channelId, interaction.member, interaction.user)) {
        return interaction.reply({
          content: '[DENIED] Bạn chỉ được phép sử dụng lệnh này tại kênh <#1273063048520667217> hoặc <#1531664569590616205>.',
          ephemeral: true
        });
      }

      // 2. Công khai cho mọi người: /status, /startmc, /help. Các lệnh khác yêu cầu Admin.
      const publicCommands = ['status', 'startmc', 'help'];
      if (!publicCommands.includes(commandName) && !isAuthorized(interaction.member, interaction.user)) {
        return interaction.reply({
          content: '[DENIED] Hiện tại không có quyền để sử dụng lệnh này.',
          ephemeral: true
        });
      }

      const instanceId = process.env.EC2_INSTANCE_ID;

      if (commandName === 'status') {
        await interaction.deferReply();
        const { embed } = await buildStatusEmbed();
        return editReplyWithAutoDelete(interaction, { embeds: [embed] }, 60000);
      }

      if (commandName === 'panel') {
        await interaction.deferReply();
        return startAutoRefreshInteractionPanel(interaction, 5000, 300000);
      }

      if (commandName === 'startmc') {
        await interaction.deferReply();
        try {
          const { state, publicIp } = await getInstanceStatus(instanceId);
          if (state !== 'running') {
            return editReplyWithAutoDelete(interaction, {
              content: `[INFO] VPS hiện tại đang ở trạng thái \`${state.toUpperCase()}\`. Vui lòng liên hệ Admin hoặc bấm bật VPS trên Website!`
            }, 60000);
          }

          const mcPort = parseInt(process.env.MC_PORT || '25565', 10);
          const mcOnline = publicIp ? await checkMinecraftServerStatus(publicIp, mcPort) : false;
          if (mcOnline) {
            const customAddress = (process.env.CUSTOM_SERVER_ADDRESS || '').trim();
            const serverAddr = customAddress || (publicIp ? `${publicIp}:${mcPort}` : 'N/A');
            return editReplyWithAutoDelete(interaction, {
              content: `[INFO] Server Minecraft hiện tại đã ONLINE rồi!\nĐịa chỉ máy chủ: \`${serverAddr}\``
            }, 60000);
          }

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

          return editReplyWithAutoDelete(interaction, {
            content: '[START MC] Đã gửi lệnh bật Server Minecraft! Vui lòng chờ khoảng 30-60 giây để server khởi động hoàn tất.'
          }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, {
            content: `[ERROR] Không thể khởi động Server Minecraft: ${err.message}`
          }, 60000);
        }
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
          return editReplyWithAutoDelete(interaction, { embeds: [embed] }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Không thể khởi động VPS: ${err.message}` }, 60000);
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
          return editReplyWithAutoDelete(interaction, { embeds: [embed] }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Không thể tắt VPS: ${err.message}` }, 60000);
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
          return editReplyWithAutoDelete(interaction, { content: '[SUCCESS] Đã gửi lệnh Restart Minecraft Server!' }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Không thể restart Minecraft Server: ${err.message}` }, 60000);
        }
      }

      if (commandName === 'rebootvps') {
        await interaction.deferReply();
        try {
          await rebootInstance(instanceId);
          return editReplyWithAutoDelete(interaction, { content: '[REBOOT] Đã gửi lệnh Restart VPS thành công! Vui lòng chờ 1-2 phút để VPS khởi động lại.' }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Không thể Restart VPS: ${err.message}` }, 60000);
        }
      }

      if (commandName === 'mode') {
        await interaction.deferReply();
        const modeType = interaction.options.getString('type');
        if (modeType === 'dev') {
          try {
            await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py dev || sudo touch /opt/mc-autoshutdown/DEV_MODE');
            currentMode = 'dev';
            return editReplyWithAutoDelete(interaction, { content: '[DEV MODE] Đã chuyển sang DEV MODE' }, 60000);
          } catch (err) {
            return editReplyWithAutoDelete(interaction, { content: `[ERROR] Lỗi khi bật Dev Mode: ${err.message}` }, 60000);
          }
        } else {
          try {
            await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py normal || sudo rm -f /opt/mc-autoshutdown/DEV_MODE');
            currentMode = 'normal';
            return editReplyWithAutoDelete(interaction, { content: '[NORMAL MODE] Đã chuyển sang NORMAL MODE' }, 60000);
          } catch (err) {
            return editReplyWithAutoDelete(interaction, { content: `[ERROR] Lỗi khi bật Normal Mode: ${err.message}` }, 60000);
          }
        }
      }

      if (commandName === 'cmd') {
        await interaction.deferReply();
        const mcCmd = interaction.options.getString('command');
        try {
          // 1. Kiểm tra trạng thái VPS & Server Minecraft
          const { state, publicIp } = await getInstanceStatus(instanceId);
          if (state !== 'running') {
            return editReplyWithAutoDelete(interaction, {
              content: `[ERROR] VPS hiện tại đang ở trạng thái \`${state.toUpperCase()}\`. Vui lòng bật VPS trước khi gửi lệnh!`
            }, 60000);
          }

          const mcPort = parseInt(process.env.MC_PORT || '25565', 10);
          const mcOnline = publicIp ? await checkMinecraftServerStatus(publicIp, mcPort) : false;
          if (!mcOnline) {
            return editReplyWithAutoDelete(interaction, {
              content: '[ERROR] Server Minecraft hiện tại đang OFFLINE hoặc đang khởi động. Vui lòng chờ Server online trước khi gửi lệnh!'
            }, 60000);
          }

          // 2. Gửi lệnh tới Minecraft Console qua RCON
          const result = await sendMinecraftRconCommand(instanceId, publicIp, mcCmd);

          // 3. Format kết quả trả về Discord (Giới hạn tối đa 1800 ký tự)
          let formattedOutput = result || '(Lệnh đã thực thi thành công, không có phản hồi văn bản)';
          if (formattedOutput.length > 1800) {
            formattedOutput = formattedOutput.substring(0, 1800) + '\n... (Nội dung đã được cắt bớt do quá dài)';
          }

          return interaction.editReply({
            content: `[MINECRAFT CONSOLE] Lệnh: \`/${mcCmd.replace(/^\//, '')}\`\n\`\`\`text\n${formattedOutput}\n\`\`\``
          });
        } catch (err) {
          return editReplyWithAutoDelete(interaction, {
            content: `[ERROR] Lỗi khi thực thi lệnh Minecraft: ${err.message}`
          }, 60000);
        }
      }

      if (commandName === 'help') {
        const helpEmbed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('Tro giup')
          .setDescription('Các câu lệnh Discord Bot:')
          .addFields(
            { name: '🌐 CÔNG KHAI (Mọi người dùng được):', value: '───────────────────────────', inline: false },
            { name: '`/status` hoặc `!status`', value: 'Xem trạng thái VPS, Server Minecraft và Địa chỉ máy chủ.', inline: false },
            { name: '`/startmc` hoặc `!startmc`', value: 'Khởi động Server Minecraft (khi VPS đã chạy).', inline: false },
            { name: '`/help` hoặc `!help`', value: 'Xem menu trợ giúp.', inline: false },
            { name: '🛠️ QUẢN TRỊ (Dành riêng cho Admin):', value: '───────────────────────────', inline: false },
            { name: '`/panel` hoặc `!panel`', value: 'Mở Bảng điều khiển Dashboard trực quan.', inline: false },
            { name: '`/start` hoặc `!start`', value: 'Bật cả VPS và Minecraft Server.', inline: false },
            { name: '`/stop` hoặc `!stop`', value: 'Tắt Minecraft Server và VPS.', inline: false },
            { name: '`/restart` hoặc `!restart`', value: 'Khởi động lại Minecraft Server.', inline: false },
            { name: '`/rebootvps` hoặc `!rebootvps`', value: 'Khởi động lại máy chủ VPS EC2.', inline: false },
            { name: '`/mode` hoặc `!mode`', value: 'Đổi chế độ Dev Mode / Normal Mode.', inline: false },
            { name: '`/cmd <lệnh>` hoặc `!cmd <lệnh>`', value: 'Gửi lệnh trực tiếp vào Console Server Minecraft.', inline: false }
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
        const { embed, ec2State } = await buildStatusEmbed();
        return interaction.editReply({ embeds: [embed], components: getDashboardActionRows(ec2State) });
      }

      // 2. Start VPS & MC
      if (customId === 'start_server') {
        await interaction.deferReply({ ephemeral: true });
        try {
          const res = await startInstance(instanceId);
          return editReplyWithAutoDelete(interaction, { content: `[START] Đã gửi lệnh bật VPS! Status: \`${res.currentState}\`. Vui lòng chờ 30-60s.` }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Lỗi khi bật VPS: ${err.message}` }, 60000);
        }
      }

      // 3. Stop VPS & MC
      if (customId === 'stop_server') {
        await interaction.deferReply({ ephemeral: true });
        try {
          await stopInstance(instanceId);
          return editReplyWithAutoDelete(interaction, { content: '[STOP] Đã gửi lệnh tắt VPS thành công!' }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Lỗi khi tắt VPS: ${err.message}` }, 60000);
        }
      }

      // 4. Restart MC
      if (customId === 'restart_server') {
        await interaction.deferReply({ ephemeral: true });
        try {
          const mcCmd = process.env.MC_START_COMMAND || 'sudo systemctl restart minecraft';
          await runSSMStartMinecraftCommand(instanceId, mcCmd);
          return editReplyWithAutoDelete(interaction, { content: '[RESTART] Đã gửi lệnh Restart Minecraft Server!' }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Lỗi khi Restart: ${err.message}` }, 60000);
        }
      }

      // 4.5. Restart VPS
      if (customId === 'reboot_vps') {
        await interaction.deferReply({ ephemeral: true });
        try {
          await rebootInstance(instanceId);
          return editReplyWithAutoDelete(interaction, { content: '[REBOOT] Đã gửi lệnh Restart VPS thành công! Vui lòng chờ 1-2 phút để VPS khởi động lại.' }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Lỗi khi Restart VPS: ${err.message}` }, 60000);
        }
      }

      // 5. Dev Mode
      if (customId === 'set_dev_mode') {
        await interaction.deferReply({ ephemeral: true });
        try {
          await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py dev || sudo touch /opt/mc-autoshutdown/DEV_MODE');
          currentMode = 'dev';
          return editReplyWithAutoDelete(interaction, { content: '[DEV MODE] Đã kích hoạt DEV MODE thành công' }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Lỗi khi bật Dev Mode: ${err.message}` }, 60000);
        }
      }

      // 6. Normal Mode
      if (customId === 'set_normal_mode') {
        await interaction.deferReply({ ephemeral: true });
        try {
          await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py normal || sudo rm -f /opt/mc-autoshutdown/DEV_MODE');
          currentMode = 'normal';
          return editReplyWithAutoDelete(interaction, { content: '[NORMAL MODE] Đã kích hoạt NORMAL MODE thành công' }, 60000);
        } catch (err) {
          return editReplyWithAutoDelete(interaction, { content: `[ERROR] Lỗi khi bật Normal Mode: ${err.message}` }, 60000);
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

  // 2. Lắng nghe tin nhắn văn bản Prefix (`!`) từ Admin & User
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();
    const lowerContent = content.toLowerCase();
    const instanceId = process.env.EC2_INSTANCE_ID;

    // 1. Kiểm tra kênh được phép cho User thường
    if (!isChannelAllowed(message.channel.id, message.member, message.author)) {
      return;
    }

    // 2. Danh sách lệnh công khai cho tất cả mọi người (!status, !startmc, !help)
    const publicPrefixes = ['!status', '!startmc', '!mcstart', '!start-mc', '!help', '!h'];
    const isPublicCmd = publicPrefixes.includes(lowerContent);

    if (!isPublicCmd && !isAuthorized(message.member, message.author)) {
      return;
    }

    // Status (Công khai cho mọi người)
    if (lowerContent === '!status') {
      const { embed } = await buildStatusEmbed();
      return sendAutoDeleteReply(message, { embeds: [embed] }, 60000);
    }

    // Panel / Admin (Dành riêng cho Admin)
    if (['!panel', '!admin'].includes(lowerContent)) {
      return startAutoRefreshMessagePanel(message, 5000, 300000);
    }

    // Start MC (Công khai cho mọi người khi VPS đang chạy)
    if (['!startmc', '!mcstart', '!start-mc'].includes(lowerContent)) {
      try {
        const { state, publicIp } = await getInstanceStatus(instanceId);
        if (state !== 'running') {
          return sendAutoDeleteReply(message, `[INFO] VPS hiện tại đang ở trạng thái \`${state.toUpperCase()}\`. Vui lòng liên hệ Admin hoặc bấm bật VPS trên Website!`, 60000);
        }

        const mcPort = parseInt(process.env.MC_PORT || '25565', 10);
        const mcOnline = publicIp ? await checkMinecraftServerStatus(publicIp, mcPort) : false;
        if (mcOnline) {
          const customAddress = (process.env.CUSTOM_SERVER_ADDRESS || '').trim();
          const serverAddr = customAddress || (publicIp ? `${publicIp}:${mcPort}` : 'N/A');
          return sendAutoDeleteReply(message, `[INFO] Server Minecraft hiện tại đã ONLINE rồi!\nĐịa chỉ máy chủ: \`${serverAddr}\``, 60000);
        }

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

        return sendAutoDeleteReply(message, '[START MC] Đã gửi lệnh bật Server Minecraft! Vui lòng chờ khoảng 30-60 giây để server khởi động hoàn tất.', 60000);
      } catch (err) {
        return sendAutoDeleteReply(message, `[ERROR] Không thể khởi động Server Minecraft: ${err.message}`, 60000);
      }
    }

    // Help
    if (['!help', '!h'].includes(lowerContent)) {
      const helpEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('Tro giup')
        .setDescription('Các câu lệnh Discord Bot:')
        .addFields(
          { name: '🌐 CÔNG KHAI (Mọi người dùng được):', value: '───────────────────────────', inline: false },
          { name: '`!status`', value: 'Xem trạng thái VPS, Server Minecraft và Địa chỉ máy chủ.', inline: false },
          { name: '`!startmc`', value: 'Khởi động Server Minecraft (khi VPS đã chạy).', inline: false },
          { name: '`!help`', value: 'Xem menu trợ giúp.', inline: false },
          { name: '🛠️ QUẢN TRỊ (Dành riêng cho Admin):', value: '───────────────────────────', inline: false },
          { name: '`!panel`', value: 'Mở Dashboard điều khiển trực quan.', inline: false },
          { name: '`!start`', value: 'Bật cả VPS và Minecraft Server.', inline: false },
          { name: '`!stop`', value: 'Tắt Minecraft Server và VPS.', inline: false },
          { name: '`!restart`', value: 'Khởi động lại Minecraft Server.', inline: false },
          { name: '`!rebootvps`', value: 'Khởi động lại máy chủ VPS EC2.', inline: false },
          { name: '`!dev on` / `!mode dev`', value: 'Bật Dev Mode.', inline: false },
          { name: '`!dev off` / `!mode normal`', value: 'Bật Normal Mode.', inline: false },
          { name: '`!cmd <lệnh>`', value: 'Gửi lệnh trực tiếp vào Console Server Minecraft.', inline: false }
        );
      return message.reply({ embeds: [helpEmbed] });
    }

    // Start
    if (lowerContent === '!start') {
      try {
        const res = await startInstance(instanceId);
        return sendAutoDeleteReply(message, `[START] Đã gửi lệnh bật VPS (${instanceId})! Status: \`${res.currentState}\`.`, 60000);
      } catch (err) {
        return sendAutoDeleteReply(message, `[ERROR] Không thể bật VPS: ${err.message}`, 60000);
      }
    }

    // Stop
    if (lowerContent === '!stop') {
      try {
        await stopInstance(instanceId);
        return sendAutoDeleteReply(message, `[STOP] Đã gửi lệnh tắt VPS (${instanceId})!`, 60000);
      } catch (err) {
        return sendAutoDeleteReply(message, `[ERROR] Không thể tắt VPS: ${err.message}`, 60000);
      }
    }

    // Restart MC
    if (lowerContent === '!restart') {
      try {
        const mcCmd = process.env.MC_START_COMMAND || 'sudo systemctl restart minecraft';
        await runSSMStartMinecraftCommand(instanceId, mcCmd);
        return sendAutoDeleteReply(message, '[RESTART] Đã gửi lệnh Restart Minecraft Server!', 60000);
      } catch (err) {
        return sendAutoDeleteReply(message, `[ERROR] Không thể Restart: ${err.message}`, 60000);
      }
    }

    // Restart VPS
    if (['!rebootvps', '!restartvps', '!vpsrestart'].includes(lowerContent)) {
      try {
        await rebootInstance(instanceId);
        return sendAutoDeleteReply(message, '[REBOOT] Đã gửi lệnh Restart VPS thành công! Vui lòng chờ 1-2 phút để VPS khởi động lại.', 60000);
      } catch (err) {
        return sendAutoDeleteReply(message, `[ERROR] Không thể Restart VPS: ${err.message}`, 60000);
      }
    }

    // Dev Mode
    if (['!mode dev', '!dev on', '!mode devmode'].includes(lowerContent)) {
      try {
        await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py dev || sudo touch /opt/mc-autoshutdown/DEV_MODE');
        currentMode = 'dev';
        return sendAutoDeleteReply(message, '[DEV MODE] Đã chuyển sang DEV MODE', 60000);
      } catch (err) {
        return sendAutoDeleteReply(message, `[ERROR] Lỗi khi bật Dev Mode: ${err.message}`, 60000);
      }
    }

    // Normal Mode
    if (['!mode normal', '!dev off', '!mode normalmode'].includes(lowerContent)) {
      try {
        await runSSMStartMinecraftCommand(instanceId, 'python3 /opt/mc-autoshutdown/auto_shutdown.py normal || sudo rm -f /opt/mc-autoshutdown/DEV_MODE');
        currentMode = 'normal';
        return sendAutoDeleteReply(message, '[NORMAL MODE] Đã chuyển sang NORMAL MODE', 60000);
      } catch (err) {
        return sendAutoDeleteReply(message, `[ERROR] Lỗi khi bật Normal Mode: ${err.message}`, 60000);
      }
    }

    // Direct Minecraft RCON Command: !cmd <command>
    if (lowerContent.startsWith('!cmd ')) {
      const mcCmd = content.substring(5).trim();
      if (!mcCmd) {
        return sendAutoDeleteReply(message, '[WARN] Vui lòng nhập câu lệnh Minecraft. Ví dụ: `!cmd list` hoặc `!cmd say Hello`', 60000);
      }

      try {
        const { state, publicIp } = await getInstanceStatus(instanceId);
        if (state !== 'running') {
          return sendAutoDeleteReply(message, `[ERROR] VPS hiện tại đang ở trạng thái \`${state.toUpperCase()}\`. Vui lòng bật VPS trước khi gửi lệnh!`, 60000);
        }

        const mcPort = parseInt(process.env.MC_PORT || '25565', 10);
        const mcOnline = publicIp ? await checkMinecraftServerStatus(publicIp, mcPort) : false;
        if (!mcOnline) {
          return sendAutoDeleteReply(message, '[ERROR] Server Minecraft hiện tại đang OFFLINE hoặc đang khởi động. Vui lòng chờ Server online trước khi gửi lệnh!', 60000);
        }

        const result = await sendMinecraftRconCommand(instanceId, publicIp, mcCmd);

        let formattedOutput = result || '(Lệnh đã thực thi thành công, không có phản hồi văn bản)';
        if (formattedOutput.length > 1800) {
          formattedOutput = formattedOutput.substring(0, 1800) + '\n... (Nội dung đã được cắt bớt do quá dài)';
        }

        return message.reply(`[MINECRAFT CONSOLE] Lệnh: \`/${mcCmd.replace(/^\//, '')}\`\n\`\`\`text\n${formattedOutput}\n\`\`\``);
      } catch (err) {
        return message.reply(`[ERROR] Lỗi khi thực thi lệnh Minecraft: ${err.message}`);
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
