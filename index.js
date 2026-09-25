// 【導入順2】Apps Scriptのデプロイ後、こちらをGitHubの index.jsへ貼り付けてください。
// 【GitHub / Render専用・現在状態同期版】この内容をGitHubの index.js に貼り付けてください。
// 【重要】Google Apps Scriptのコード.gsには貼り付けないでください。
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require('discord.js');
const express = require('express');
const axios = require('axios');
const { randomUUID } = require('crypto');

// ===============================================================
// 設定
// ===============================================================

const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL;
const TARGET_CHANNEL_ID = '1524050005290127370';
const TRANSIT_ANNOUNCE_CHANNEL_ID = '665914244306436107';
const TRANSIT_ANNOUNCEMENT = 'デニス：大魔法！トランジション発動！';
const PORT = Number(process.env.PORT) || 3000;

// 一括同期で取得するメッセージ数。必要ならRenderの環境変数で変更できます。
const MAX_SYNC_MESSAGES = Math.max(
  100,
  Number.parseInt(process.env.MAX_SYNC_MESSAGES || '1000', 10) || 1000
);

// BOT起動中はこの間隔でDiscordの現在状態を全件再同期します（初期値10分）。
const FULL_SYNC_INTERVAL_MINUTES = Math.max(
  5,
  Number.parseInt(process.env.FULL_SYNC_INTERVAL_MINUTES || '10', 10) || 10
);
const FULL_SYNC_INTERVAL_MS = FULL_SYNC_INTERVAL_MINUTES * 60 * 1000;

if (!DISCORD_BOT_TOKEN) {
  throw new Error('Renderの環境変数 DISCORD_TOKEN が設定されていません。');
}

if (!GAS_WEBHOOK_URL) {
  throw new Error('Renderの環境変数 GAS_WEBHOOK_URL が設定されていません。');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

const gasClient = axios.create({
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

let TRIGGER_VC_ID = '';
let CATEGORY_ID = '';
let syncInProgress = false;
let periodicSyncTimer = null;
const messageSnapshotTimers = new Map();
const pendingMessageSnapshots = new Map();
let gasRequestChain = Promise.resolve();
const pendingReactionLogs = [];
let reactionLogFlushTimer = null;
let reactionLogFlushInProgress = false;
let shuttingDown = false;
const REACTION_LOG_BATCH_DELAY_MS = 1000;
const REACTION_LOG_BATCH_SIZE = 100;
const REACTION_LOG_RETRY_DELAY_MS = 5000;
const voiceMoveInProgress = new Set();

const TRANSIT_COMMAND = new SlashCommandBuilder()
  .setName('transit')
  .setDescription('指定したVCの全メンバーを別のVCへ移動します')
  .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
  .addChannelOption(option =>
    option
      .setName('移動元')
      .setDescription('全員を移動させる元のVC')
      .addChannelTypes(ChannelType.GuildVoice)
      .setRequired(true)
  )
  .addChannelOption(option =>
    option
      .setName('移動先')
      .setDescription('全員の移動先となるVC')
      .addChannelTypes(ChannelType.GuildVoice)
      .setRequired(true)
  );

// チャンネルID => 部屋番号
const createdVoiceChannels = new Map();
const reservedVoiceNumbers = new Set();

// ===============================================================
// 共通処理
// ===============================================================

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function postToGasDirect(payload, attempts = 5) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await gasClient.post(GAS_WEBHOOK_URL, payload);
      if (response.data?.status === 'busy') {
        const busyError = new Error('GASが別の同期処理を実行中です。');
        busyError.code = 'GAS_BUSY';
        throw busyError;
      }
      if (response.data?.status === 'error') {
        throw new Error(`GAS処理エラー: ${response.data.message || '詳細なし'}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      console.error(
        `❌ GAS通信失敗 (${attempt}/${attempts})` +
        `${status ? ` HTTP ${status}` : ''}: ${error.message}`
      );

      if (attempt < attempts) await wait(1500 * attempt);
    }
  }

  throw lastError;
}

// GASへの同時アクセスを防ぎ、リアクション集中時も必ず1件ずつ送ります。
function postToGas(payload, attempts = 5) {
  const request = gasRequestChain
    .catch(() => undefined)
    .then(() => postToGasDirect(payload, attempts));
  gasRequestChain = request;
  return request;
}

async function loadVoiceConfig() {
  try {
    const response = await postToGas({ event: 'vc_config' });
    const triggerVcId = String(response.data?.triggerVcId || '').trim();
    const categoryId = String(response.data?.categoryId || '').trim();

    if (!triggerVcId || !categoryId) {
      throw new Error('GASから受け取ったVC設定が空です。');
    }

    TRIGGER_VC_ID = triggerVcId;
    CATEGORY_ID = categoryId;
    console.log(`📡 VC設定取得完了: トリガー=${TRIGGER_VC_ID}, カテゴリ=${CATEGORY_ID}`);
    return true;
  } catch (error) {
    console.error(`❌ VC設定取得失敗: ${error.message}`);
    return false;
  }
}

async function restoreTemporaryVoiceChannels() {
  if (!CATEGORY_ID) return;

  try {
    const category = await client.channels.fetch(CATEGORY_ID);
    if (!category || !category.guild) {
      throw new Error('設定されたカテゴリーが見つかりません。');
    }

    const guild = category.guild;
    await guild.channels.fetch();
    createdVoiceChannels.clear();

    const temporaryChannels = guild.channels.cache.filter(channel =>
      channel.type === ChannelType.GuildVoice &&
      channel.parentId === CATEGORY_ID &&
      /^自動VC-(?:[1-9]|1\d|2[0-5])$/.test(channel.name)
    );

    for (const channel of temporaryChannels.values()) {
      const number = Number.parseInt(channel.name.replace('自動VC-', ''), 10);

      // 再起動時点ですでに空なら、残骸として安全に削除します。
      if (channel.members.size === 0) {
        try {
          await channel.delete('Bot再起動時に空の臨時VCを整理');
          console.log(`🧹 空の ${channel.name} を整理しました。`);
        } catch (error) {
          console.error(`❌ ${channel.name} の整理失敗: ${error.message}`);
        }
        continue;
      }

      createdVoiceChannels.set(channel.id, number);
    }

    console.log(`🔄 使用中の臨時VCを${createdVoiceChannels.size}件復元しました。`);
  } catch (error) {
    console.error(`❌ 臨時VCの復元失敗: ${error.message}`);
  }
}

async function prepareReaction(reaction) {
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();
  return reaction;
}

function makeReactionPayload(reaction, user, action, occurredAt, eventId) {
  const guildMember = reaction.message.guild?.members.cache.get(user.id);
  const categoryName = reaction.message.channel.parent?.name || 'なし';

  return {
    event: action === '追加' ? 'reactionAdd' : 'reactionRemove',
    action,
    userName: guildMember?.displayName || user.username,
    userId: user.id,
    emoji: reaction.emoji.id
      ? `<:${reaction.emoji.name}:${reaction.emoji.id}>`
      : reaction.emoji.name,
    messageId: reaction.message.id,
    messageContent: reaction.message.content || '[画像または埋め込みメッセージ]',
    category: categoryName,
    timestamp: occurredAt || new Date().toISOString(),
    eventId: eventId || randomUUID()
  };
}

function scheduleReactionLogFlush(delayMs = REACTION_LOG_BATCH_DELAY_MS) {
  if (reactionLogFlushTimer || reactionLogFlushInProgress || pendingReactionLogs.length === 0) {
    return;
  }

  reactionLogFlushTimer = setTimeout(() => {
    reactionLogFlushTimer = null;
    void flushReactionLogQueue();
  }, delayMs);
}

function enqueueReactionLog(payload) {
  pendingReactionLogs.push(payload);
  scheduleReactionLogFlush();
}

async function flushReactionLogQueue() {
  if (reactionLogFlushInProgress || pendingReactionLogs.length === 0) return;

  reactionLogFlushInProgress = true;
  const batch = pendingReactionLogs.splice(0, REACTION_LOG_BATCH_SIZE);
  let retryRequired = false;

  try {
    const response = await postToGas({ event: 'reactionLogBatch', logs: batch });
    const savedCount = Number(response.data?.count ?? batch.length);
    const skippedCount = Number(response.data?.duplicatesSkipped ?? 0);
    console.log(
      `🧾 リアクション履歴を一括保存: ${savedCount}件` +
      `${skippedCount > 0 ? `（重複${skippedCount}件を除外）` : ''}`
    );
  } catch (error) {
    // 送信できなかった分を先頭へ戻し、新しく来たイベントより先に再試行します。
    pendingReactionLogs.unshift(...batch);
    retryRequired = true;
    console.error(
      `❌ リアクション履歴${batch.length}件の一括保存失敗。待機列へ戻しました: ${error.message}`
    );
  } finally {
    reactionLogFlushInProgress = false;
    if (pendingReactionLogs.length > 0) {
      scheduleReactionLogFlush(
        retryRequired ? REACTION_LOG_RETRY_DELAY_MS : REACTION_LOG_BATCH_DELAY_MS
      );
    }
  }
}

function formatEmoji(emoji) {
  return emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;
}

async function fetchAllReactionUsers(reaction) {
  const users = [];
  let after;

  while (true) {
    const batch = await reaction.users.fetch({
      limit: 100,
      ...(after ? { after } : {})
    });

    for (const user of batch.values()) {
      if (!user.bot) users.push(user);
    }

    if (batch.size < 100) break;
    after = batch.last()?.id;
    if (!after) break;
  }

  return users;
}

async function buildMessageSnapshot(message) {
  if (message.partial) await message.fetch();
  const guild = message.guild;
  const reactions = [];

  for (const reaction of message.reactions.cache.values()) {
    const users = await fetchAllReactionUsers(reaction);

    for (const user of users) {
      const member = guild
        ? (guild.members.cache.get(user.id) || await guild.members.fetch(user.id).catch(() => null))
        : null;

      reactions.push({
        userId: user.id,
        userName: member?.displayName || user.username,
        emoji: formatEmoji(reaction.emoji)
      });
    }
  }

  return {
    messageId: message.id,
    messageContent: message.content || '[画像または埋め込みメッセージ]',
    createdAt: message.createdAt?.toISOString() || new Date().toISOString(),
    editedAt: message.editedAt?.toISOString() || '',
    reactions
  };
}

async function syncSingleMessage(messageId, reason = 'event') {
  if (!client.isReady()) return;

  try {
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`対象テキストチャンネルが見つかりません: ${TARGET_CHANNEL_ID}`);
    }

    const message = await channel.messages.fetch(messageId);
    const snapshot = await buildMessageSnapshot(message);
    await postToGas({ event: 'messageSnapshot', reason, message: snapshot });
    console.log(
      `📨 現在状態を同期: ${messageId}（${snapshot.reactions.length}リアクション）`
    );
  } catch (error) {
    if (error.code === 10008) return;
    console.error(`❌ メッセージ現在状態の同期失敗 (${messageId}): ${error.message}`);
  }
}

function queueMessageSnapshot(messageId, reason) {
  const existingTimer = messageSnapshotTimers.get(messageId);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    messageSnapshotTimers.delete(messageId);
    if (syncInProgress) {
      pendingMessageSnapshots.set(messageId, reason);
      return;
    }
    void syncSingleMessage(messageId, reason);
  }, 1200);

  messageSnapshotTimers.set(messageId, timer);
}

async function flushPendingMessageSnapshots() {
  if (pendingMessageSnapshots.size === 0) return;
  const pending = [...pendingMessageSnapshots.entries()];
  pendingMessageSnapshots.clear();

  console.log(`🔁 全体同期中に保留した${pending.length}件を再同期します。`);
  for (const [messageId, reason] of pending) {
    await syncSingleMessage(messageId, `${reason}:afterFullSync`);
  }
}

async function registerTransitCommandForGuild(guild) {
  try {
    const commandData = TRANSIT_COMMAND.toJSON();
    const commands = await guild.commands.fetch();
    const existingCommand = commands.find(command => command.name === commandData.name);

    // 旧版を一度導入していた場合も、古いコマンドを一覧に残しません。
    const obsoleteCommands = commands.filter(command =>
      command.name === 'vcmove' || command.name === 'transi'
    );
    for (const obsoleteCommand of obsoleteCommands.values()) {
      await obsoleteCommand.delete();
    }

    if (existingCommand) {
      await existingCommand.edit(commandData);
    } else {
      await guild.commands.create(commandData);
    }

    console.log(`✅ /transit コマンド登録完了: ${guild.name}`);
  } catch (error) {
    console.error(`❌ /transit コマンド登録失敗 (${guild.name}): ${error.message}`);
  }
}

async function registerTransitCommands() {
  for (const guild of client.guilds.cache.values()) {
    await registerTransitCommandForGuild(guild);
  }
}

async function replyToTransitCommand(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content });
  }
  return interaction.reply({ content, ephemeral: true });
}

// ===============================================================
// Renderの生存確認
// ===============================================================

app.get('/', (req, res) => {
  res.status(client.isReady() ? 200 : 503).json({
    webServer: 'running',
    discord: client.isReady() ? 'connected' : 'disconnected',
    bot: client.user?.tag || null,
    syncInProgress
  });
});

// ===============================================================
// Bot起動
// ===============================================================

client.once('clientReady', async () => {
  console.log(`🤖 Bot起動完了: ${client.user.tag}`);

  await registerTransitCommands();

  const loaded = await loadVoiceConfig();
  if (loaded) {
    await restoreTemporaryVoiceChannels();
  } else {
    console.log('⏳ 60秒後にVC設定の取得を再試行します。');
    const retryTimer = setInterval(async () => {
      if (await loadVoiceConfig()) {
        clearInterval(retryTimer);
        await restoreTemporaryVoiceChannels();
      }
    }, 60000);
  }

  // 再起動中に起きたリアクションも復元できるよう、起動後に全体同期します。
  setTimeout(() => {
    if (!syncInProgress) {
      syncInProgress = true;
      void performBulkSync('startup');
    }
  }, 10000);

  if (!periodicSyncTimer) {
    periodicSyncTimer = setInterval(() => {
      if (!client.isReady() || syncInProgress) return;
      syncInProgress = true;
      void performBulkSync('periodic');
    }, FULL_SYNC_INTERVAL_MS);
    console.log(`⏱️ 現在状態の全体同期を${FULL_SYNC_INTERVAL_MINUTES}分おきに実行します。`);
  }
});

client.on('guildCreate', guild => {
  void registerTransitCommandForGuild(guild);
});

// ===============================================================
// 機能1：VCメンバー一括移動コマンド
// ===============================================================

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'transit') return;

  try {
    if (!interaction.inGuild() || !interaction.guild) {
      await replyToTransitCommand(interaction, '❌ このコマンドはサーバー内でのみ使えます。');
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.MoveMembers)) {
      await replyToTransitCommand(
        interaction,
        '❌ このコマンドには「メンバーを移動」の権限が必要です。'
      );
      return;
    }

    const sourceChannel = interaction.options.getChannel('移動元', true);
    const targetChannel = interaction.options.getChannel('移動先', true);

    if (
      sourceChannel.type !== ChannelType.GuildVoice ||
      targetChannel.type !== ChannelType.GuildVoice
    ) {
      await replyToTransitCommand(interaction, '❌ 移動元と移動先にはVCを指定してください。');
      return;
    }

    if (sourceChannel.id === targetChannel.id) {
      await replyToTransitCommand(interaction, '❌ 移動元と移動先に同じVCは指定できません。');
      return;
    }

    if (targetChannel.id === TRIGGER_VC_ID) {
      await replyToTransitCommand(
        interaction,
        '❌ 自動VC作成用のトリガーVCは移動先に指定できません。'
      );
      return;
    }

    const botMember = interaction.guild.members.me;
    const sourcePermissions = botMember ? sourceChannel.permissionsFor(botMember) : null;
    const targetPermissions = botMember ? targetChannel.permissionsFor(botMember) : null;
    const canReadSource = sourcePermissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.MoveMembers
    ]);
    const canUseTarget = targetPermissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.MoveMembers
    ]);

    if (!canReadSource || !canUseTarget) {
      await replyToTransitCommand(
        interaction,
        '❌ BOTに「チャンネルを見る」「接続」「メンバーを移動」の権限が必要です。'
      );
      return;
    }

    const moveKey = `${interaction.guildId}:${sourceChannel.id}`;
    if (voiceMoveInProgress.has(moveKey)) {
      await replyToTransitCommand(interaction, '⏳ このVCは現在一括移動中です。');
      return;
    }

    const membersToMove = [...sourceChannel.members.values()];
    if (membersToMove.length === 0) {
      await replyToTransitCommand(interaction, `ℹ️ <#${sourceChannel.id}> にメンバーはいません。`);
      return;
    }

    voiceMoveInProgress.add(moveKey);
    await interaction.deferReply({ ephemeral: true });

    const movedMembers = [];
    const failedMembers = [];
    let noLongerInSource = 0;

    try {
      const announcementChannel = await client.channels.fetch(TRANSIT_ANNOUNCE_CHANNEL_ID);
      if (
        !announcementChannel ||
        !announcementChannel.isTextBased() ||
        typeof announcementChannel.send !== 'function'
      ) {
        throw new Error(`告知先チャンネルが見つからないか、コメントを送信できません: ${TRANSIT_ANNOUNCE_CHANNEL_ID}`);
      }

      await announcementChannel.send(TRANSIT_ANNOUNCEMENT);

      for (const member of membersToMove) {
        if (member.voice.channelId !== sourceChannel.id) {
          noLongerInSource++;
          continue;
        }

        try {
          await member.voice.setChannel(
            targetChannel,
            `/transit を ${interaction.user.tag} が実行`
          );
          movedMembers.push(member.displayName);
        } catch (error) {
          failedMembers.push(`${member.displayName}（${error.message}）`);
        }
      }
    } finally {
      voiceMoveInProgress.delete(moveKey);
    }

    const resultLines = [
      `✅ <#${sourceChannel.id}> → <#${targetChannel.id}>`,
      `移動完了: ${movedMembers.length}人 / 対象: ${membersToMove.length}人`
    ];

    if (noLongerInSource > 0) {
      resultLines.push(`実行中に移動・退出: ${noLongerInSource}人`);
    }
    if (failedMembers.length > 0) {
      const visibleFailures = failedMembers.slice(0, 5);
      resultLines.push(`移動失敗: ${failedMembers.length}人`);
      resultLines.push(visibleFailures.join('\n'));
      if (failedMembers.length > visibleFailures.length) {
        resultLines.push(`ほか${failedMembers.length - visibleFailures.length}人`);
      }
    }

    await interaction.editReply({ content: resultLines.join('\n') });
    console.log(
      `🚚 VC一括移動完了: ${sourceChannel.name} → ${targetChannel.name}、` +
      `成功=${movedMembers.length}、失敗=${failedMembers.length}`
    );
  } catch (error) {
    console.error(`❌ /transit コマンド処理失敗: ${error.message}`);
    try {
      await replyToTransitCommand(
        interaction,
        `❌ VCの一括移動に失敗しました: ${error.message}`
      );
    } catch (replyError) {
      console.error(`❌ /transit エラー応答失敗: ${replyError.message}`);
    }
  }
});

// ===============================================================
// 機能2：臨時VCの自動生成・自動削除
// ===============================================================

client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member;
  if (!member || member.user.bot) return;

  if (newState.channelId === TRIGGER_VC_ID && oldState.channelId !== TRIGGER_VC_ID) {
    let nextNumber = -1;

    try {
      const usedNumbers = new Set([
        ...createdVoiceChannels.values(),
        ...reservedVoiceNumbers.values()
      ]);

      for (let number = 1; number <= 25; number++) {
        if (!usedNumbers.has(number)) {
          nextNumber = number;
          break;
        }
      }

      if (nextNumber === -1) {
        console.log('⚠️ 臨時VCが最大数（25部屋）に達しています。');
        return;
      }

      // 同時入室で同じ番号が選ばれないよう、作成前に予約します。
      reservedVoiceNumbers.add(nextNumber);
      const channelName = `自動VC-${nextNumber}`;

      const newChannel = await newState.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: CATEGORY_ID || null,
        reason: 'ユーザー入室による臨時VC自動作成'
      });

      createdVoiceChannels.set(newChannel.id, nextNumber);
      await member.voice.setChannel(newChannel);
      console.log(`🔊 ${channelName} を作成し、${member.user.tag} を移動しました。`);
    } catch (error) {
      console.error(`❌ 臨時VCの作成・移動失敗: ${error.message}`);
    } finally {
      if (nextNumber !== -1) reservedVoiceNumbers.delete(nextNumber);
    }
  }

  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const oldChannel = oldState.channel;

    if (
      createdVoiceChannels.has(oldState.channelId) &&
      oldChannel &&
      oldChannel.members.size === 0
    ) {
      const number = createdVoiceChannels.get(oldState.channelId);

      try {
        await oldChannel.delete('臨時VCが空になったため自動削除');
        createdVoiceChannels.delete(oldState.channelId);
        console.log(`🗑️ 自動VC-${number} を削除しました。`);
      } catch (error) {
        console.error(`❌ 自動VC-${number} の削除失敗: ${error.message}`);
      }
    }
  }
});

// ===============================================================
// 機能3：リアクション追加・削除
// ===============================================================

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  const occurredAt = new Date().toISOString();
  const eventId = randomUUID();

  try {
    await prepareReaction(reaction);
    if (reaction.message.channelId !== TARGET_CHANNEL_ID) return;
    enqueueReactionLog(makeReactionPayload(reaction, user, '追加', occurredAt, eventId));
    queueMessageSnapshot(reaction.message.id, 'reactionAdd');
  } catch (error) {
    console.error(`❌ リアクション追加の処理失敗: ${error.message}`);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;

  const occurredAt = new Date().toISOString();
  const eventId = randomUUID();

  try {
    await prepareReaction(reaction);
    if (reaction.message.channelId !== TARGET_CHANNEL_ID) return;
    enqueueReactionLog(makeReactionPayload(reaction, user, '削除', occurredAt, eventId));
    queueMessageSnapshot(reaction.message.id, 'reactionRemove');
  } catch (error) {
    console.error(`❌ リアクション削除の処理失敗: ${error.message}`);
  }
});

client.on('messageReactionRemoveAll', message => {
  if (message.channelId !== TARGET_CHANNEL_ID) return;
  queueMessageSnapshot(message.id, 'reactionRemoveAll');
});

client.on('messageReactionRemoveEmoji', async reaction => {
  try {
    await prepareReaction(reaction);
    if (reaction.message.channelId !== TARGET_CHANNEL_ID) return;
    queueMessageSnapshot(reaction.message.id, 'reactionRemoveEmoji');
  } catch (error) {
    console.error(`❌ リアクション全削除の同期失敗: ${error.message}`);
  }
});

// 新規投稿・編集も現在状態へ反映します。リアクション0件の投稿も対象です。
client.on('messageCreate', message => {
  if (message.channelId !== TARGET_CHANNEL_ID) return;
  queueMessageSnapshot(message.id, 'messageCreate');
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) await newMessage.fetch();
    if (newMessage.channelId !== TARGET_CHANNEL_ID) return;
    queueMessageSnapshot(newMessage.id, 'messageUpdate');
  } catch (error) {
    console.error(`❌ メッセージ編集同期失敗: ${error.message}`);
  }
});

// ===============================================================
// 機能4：メッセージ削除時のログ削除
// ===============================================================

client.on('messageDelete', async message => {
  if (message.channelId !== TARGET_CHANNEL_ID) return;

  try {
    await postToGas({ event: 'messageDelete', messageId: message.id });
    console.log(`🗑️ 削除メッセージをGASへ通知しました: ${message.id}`);
  } catch (error) {
    console.error(`❌ メッセージ削除通知失敗: ${error.message}`);
  }
});

client.on('messageDeleteBulk', async messages => {
  const targetMessages = [...messages.values()].filter(
    message => message.channelId === TARGET_CHANNEL_ID
  );

  for (const message of targetMessages) {
    try {
      await postToGas({ event: 'messageDelete', messageId: message.id });
    } catch (error) {
      console.error(`❌ 一括削除メッセージの通知失敗 (${message.id}): ${error.message}`);
    }
  }
});

// ===============================================================
// 機能5：GASからの一括同期
// ===============================================================

async function fetchMessagesForSync(channel, maximum) {
  const collected = [];
  let before;

  while (collected.length < maximum) {
    const remaining = maximum - collected.length;
    const batch = await channel.messages.fetch({
      limit: Math.min(100, remaining),
      ...(before ? { before } : {})
    });

    if (batch.size === 0) break;
    collected.push(...batch.values());
    before = batch.last().id;
    if (batch.size < Math.min(100, remaining)) break;
  }

  return collected;
}

async function performBulkSync(reason = 'manual') {
  try {
    console.log(
      `🔄 現在状態の全体同期開始（理由=${reason}、最大${MAX_SYNC_MESSAGES}メッセージ）`
    );
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);

    if (!channel || !channel.isTextBased() || !channel.guild) {
      throw new Error(`対象テキストチャンネルが見つかりません: ${TARGET_CHANNEL_ID}`);
    }

    const messages = await fetchMessagesForSync(channel, MAX_SYNC_MESSAGES);
    const snapshots = [];

    for (const message of messages) {
      snapshots.push(await buildMessageSnapshot(message));
    }

    const reactionCount = snapshots.reduce(
      (total, message) => total + message.reactions.length,
      0
    );

    await postToGas({
      event: 'fullSnapshot',
      reason,
      syncedAt: new Date().toISOString(),
      messages: snapshots
    });
    console.log(
      `✅ 現在状態の全体同期完了: ${snapshots.length}メッセージ、${reactionCount}リアクション`
    );
  } catch (error) {
    console.error(`❌ 一括同期失敗: ${error.message}`);
  } finally {
    syncInProgress = false;
    await flushPendingMessageSnapshots();
  }
}

app.post('/sync', (req, res) => {
  if (!client.isReady()) {
    return res.status(503).json({ status: 'error', message: 'Discordへ未接続です。' });
  }

  if (syncInProgress) {
    return res.status(200).json({ status: 'already_processing' });
  }

  syncInProgress = true;
  res.status(200).json({ status: 'processing', message: '一括同期を開始しました。' });
  void performBulkSync('manual');
});

// ===============================================================
// エラー記録と終了処理
// ===============================================================

client.on('error', error => console.error('❌ Discordクライアントエラー:', error));
client.on('warn', warning => console.warn('⚠️ Discord警告:', warning));
client.on('shardError', (error, shardId) => {
  console.error(`❌ Discord Gatewayエラー (Shard ${shardId}): ${error.message}`);
});
client.on('shardDisconnect', (event, shardId) => {
  console.error(
    `❌ Discord切断 (Shard ${shardId}): code=${event.code}, reason=${event.reason || '理由なし'}`
  );
});
client.on('shardReconnecting', shardId => {
  console.log(`🔄 Discordへ再接続中 (Shard ${shardId})`);
});
client.on('invalidated', () => {
  console.error('❌ Discordセッションが無効になりました。Renderの再起動が必要です。');
});

process.on('unhandledRejection', error => {
  console.error('❌ 未処理のPromiseエラー:', error);
});

async function flushReactionLogsBeforeShutdown() {
  if (reactionLogFlushTimer) {
    clearTimeout(reactionLogFlushTimer);
    reactionLogFlushTimer = null;
  }

  const deadline = Date.now() + 8000;
  while ((reactionLogFlushInProgress || pendingReactionLogs.length > 0) && Date.now() < deadline) {
    if (reactionLogFlushInProgress) {
      await Promise.race([
        gasRequestChain.catch(() => undefined),
        wait(250)
      ]);
      continue;
    }

    const countBeforeFlush = pendingReactionLogs.length;
    const remainingTime = Math.max(0, deadline - Date.now());
    await Promise.race([
      flushReactionLogQueue(),
      wait(remainingTime)
    ]);
    if (reactionLogFlushInProgress) break;
    if (reactionLogFlushTimer) {
      clearTimeout(reactionLogFlushTimer);
      reactionLogFlushTimer = null;
    }

    // 5回の通信再試行後も保存できなければ、終了時に連打せず打ち切ります。
    if (pendingReactionLogs.length >= countBeforeFlush) break;
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal}を受信したため終了します。`);
  if (periodicSyncTimer) clearInterval(periodicSyncTimer);
  for (const timer of messageSnapshotTimers.values()) clearTimeout(timer);
  if (pendingReactionLogs.length > 0) {
    console.log(`🧾 終了前に未送信のリアクション履歴${pendingReactionLogs.length}件を保存します。`);
  }
  await flushReactionLogsBeforeShutdown();
  if (pendingReactionLogs.length > 0) {
    console.warn(`⚠️ 終了前に保存できなかったリアクション履歴が${pendingReactionLogs.length}件あります。`);
  }
  pendingMessageSnapshots.clear();
  client.destroy();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

app.listen(PORT, () => {
  console.log(`🌐 Web Server listening on port ${PORT}`);
});

console.log('🔌 Discord Gatewayへ接続を開始します...');
client.login(DISCORD_BOT_TOKEN).catch(error => {
  console.error(`❌ Discordログイン失敗: ${error.message}`);
});
