const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const express = require('express');
const axios = require('axios');

// ===============================================================
// 設定
// ===============================================================

const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL;
const TARGET_CHANNEL_ID = '1524050005290127370';
const PORT = Number(process.env.PORT) || 3000;

// 一括同期で取得するメッセージ数。必要ならRenderの環境変数で変更できます。
const MAX_SYNC_MESSAGES = Math.max(
  100,
  Number.parseInt(process.env.MAX_SYNC_MESSAGES || '1000', 10) || 1000
);

if (!DISCORD_BOT_TOKEN) {
  throw new Error('Renderの環境変数 DISCORD_TOKEN が設定されていません。');
}

if (!GAS_WEBHOOK_URL) {
  throw new Error('Renderの環境変数 GAS_WEBHOOK_URL が設定されていません。');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

const gasClient = axios.create({
  timeout: 15000,
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

// チャンネルID => 部屋番号
const createdVoiceChannels = new Map();
const reservedVoiceNumbers = new Set();

// ===============================================================
// 共通処理
// ===============================================================

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function postToGas(payload, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await gasClient.post(GAS_WEBHOOK_URL, payload);
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      console.error(
        `❌ GAS通信失敗 (${attempt}/${attempts})` +
        `${status ? ` HTTP ${status}` : ''}: ${error.message}`
      );

      if (attempt < attempts) {
        await wait(1000 * attempt);
      }
    }
  }

  throw lastError;
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

function makeReactionPayload(reaction, user, action) {
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
    category: categoryName
  };
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

client.once('ready', async () => {
  console.log(`🤖 Bot起動完了: ${client.user.tag}`);

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
});

// ===============================================================
// 機能1：臨時VCの自動生成・自動削除
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
// 機能2：リアクション追加・削除
// ===============================================================

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  try {
    await prepareReaction(reaction);
    if (reaction.message.channelId !== TARGET_CHANNEL_ID) return;
    await postToGas(makeReactionPayload(reaction, user, '追加'));
  } catch (error) {
    console.error(`❌ リアクション追加の処理失敗: ${error.message}`);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;

  try {
    await prepareReaction(reaction);
    if (reaction.message.channelId !== TARGET_CHANNEL_ID) return;
    await postToGas(makeReactionPayload(reaction, user, '削除'));
  } catch (error) {
    console.error(`❌ リアクション削除の処理失敗: ${error.message}`);
  }
});

// ===============================================================
// 機能3：メッセージ削除時のログ削除
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

// ===============================================================
// 機能4：GASからの一括同期
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

async function performBulkSync() {
  try {
    console.log(`🔄 一括同期開始（最大${MAX_SYNC_MESSAGES}メッセージ）`);
    const allLogs = [];
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);

    if (!channel || !channel.isTextBased() || !channel.guild) {
      throw new Error(`対象テキストチャンネルが見つかりません: ${TARGET_CHANNEL_ID}`);
    }

    const messages = await fetchMessagesForSync(channel, MAX_SYNC_MESSAGES);

    for (const message of messages) {
      for (const reaction of message.reactions.cache.values()) {
        const users = await reaction.users.fetch();

        for (const user of users.values()) {
          if (user.bot) continue;

          const member = await channel.guild.members.fetch(user.id).catch(() => null);
          allLogs.push({
            timestamp: message.createdAt.toISOString(),
            userName: member?.displayName || user.username,
            userId: user.id,
            emoji: reaction.emoji.id
              ? `<:${reaction.emoji.name}:${reaction.emoji.id}>`
              : reaction.emoji.name,
            action: '追加',
            messageId: message.id,
            messageContent: message.content || '（内容取得不可）'
          });
        }
      }
    }

    await postToGas({ event: 'bulkSync', data: allLogs });
    console.log(
      `✅ 一括同期完了: ${messages.length}メッセージ、${allLogs.length}リアクション`
    );
  } catch (error) {
    console.error(`❌ 一括同期失敗: ${error.message}`);
  } finally {
    syncInProgress = false;
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
  void performBulkSync();
});

// ===============================================================
// エラー記録と終了処理
// ===============================================================

client.on('error', error => console.error('❌ Discordクライアントエラー:', error));
client.on('warn', warning => console.warn('⚠️ Discord警告:', warning));

process.on('unhandledRejection', error => {
  console.error('❌ 未処理のPromiseエラー:', error);
});

function shutdown(signal) {
  console.log(`🛑 ${signal}を受信したため終了します。`);
  client.destroy();
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

app.listen(PORT, () => {
  console.log(`🌐 Web Server listening on port ${PORT}`);
});

client.login(DISCORD_BOT_TOKEN).catch(error => {
  console.error(`❌ Discordへのログイン失敗: ${error.message}`);
  process.exit(1);
});
