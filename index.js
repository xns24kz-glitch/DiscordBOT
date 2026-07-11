const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// 環境変数からトークンとGASのURLを読み込み
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL;

// 🏗️ Bot初期化（すべての権限とパーシャルを網羅）
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

// GASから設定（ID情報）を取得するための変数
let TRIGGER_VC_ID = "";
let CATEGORY_ID = "";

// 作成された臨時VCを追跡するマップ (チャンネルID => 番号)
const createdVoiceChannels = new Map();

// サーバー生存確認用のエンドポイント
app.get('/', (req, res) => {
  res.send('Discord Bot is running and sync system is active!');
});

// Bot起動時の処理
client.once('ready', async () => {
  console.log(`🤖 Botが正常に起動しました: ${client.user.tag}`);
  
  // 起動時にGASから自動でID情報を引っ張ってくる
  try {
    const response = await axios.post(GAS_WEBHOOK_URL, { event: "vc_config" });
    TRIGGER_VC_ID = response.data.triggerVcId;
    CATEGORY_ID = response.data.categoryId;
    console.log(`📡 GASから設定を読み込みました。トリガーVC: ${TRIGGER_VC_ID}, カテゴリ: ${CATEGORY_ID}`);
  } catch (error) {
    console.error("❌ GASからの設定取得に失敗しました。時間をおいて再デプロイしてください:", error.message);
  }
});

// ===============================================================
// 🔊 機能1：臨時VCの自動生成＆自動消去（連番・最大25部屋）
// ===============================================================
client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member;
  if (!member || member.user.bot) return;

  // 1. ユーザーがトリガーVCに入室した場合
  if (newState.channelId === TRIGGER_VC_ID && oldState.channelId !== TRIGGER_VC_ID) {
    try {
      const guild = newState.guild;

      // 現在使われている連番（1〜25）を調査
      const usedNumbers = new Set(createdVoiceChannels.values());
      
      // 1から順に空いている番号を探す
      let nextNumber = -1;
      for (let i = 1; i <= 25; i++) {
        if (!usedNumbers.has(i)) {
          nextNumber = i;
          break;
        }
      }

      // 25部屋すべて埋まっていたら作成をスキップ
      if (nextNumber === -1) {
        console.log("⚠️ 最大部屋数（25部屋）に達しているため、新規作成をスキップしました。");
        return;
      }

      const channelName = `自動VC-${nextNumber}`;

      // 臨時VCの作成
      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: CATEGORY_ID || null,
        reason: 'ユーザー入室による臨時VC自動作成'
      });

      // マップに記録（どのチャンネルが何番か）
      createdVoiceChannels.set(newChannel.id, nextNumber);

      // ユーザーを作成した部屋に移動させる
      await member.voice.setChannel(newChannel);
      console.log(`🔊 ${channelName} を作成し、${member.user.tag} を移動しました。`);

    } catch (error) {
      console.error('❌ 臨時VCの作成または移動に失敗しました:', error);
    }
  }

  // 2. ユーザーがVCから退室、または別のVCに移動した場合
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const oldChannel = oldState.channel;
    
    // その部屋がBotの作った臨時VCであり、かつメンバーが0人になった場合
    if (createdVoiceChannels.has(oldState.channelId) && oldChannel && oldChannel.members.size === 0) {
      try {
        const number = createdVoiceChannels.get(oldState.channelId);
        await oldChannel.delete('臨時VCに誰もいなくなったため自動削除');
        createdVoiceChannels.delete(oldState.channelId); // マップから削除して番号解放
        console.log(`🗑️ 誰もいなくなったため 自動VC-${number} を削除しました。`);
      } catch (error) {
        console.error('❌ 臨時VCの削除に失敗しました:', error);
      }
    }
  }
});

// ===============================================================
// 🔄 機能2：リアルタイムでのリアクション（スタンプ）追加・削除検知
// ===============================================================
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch (error) { return console.error('リアクション取得失敗:', error); }
  }

  let categoryName = "なし";
  if (reaction.message.channel.parent) {
    categoryName = reaction.message.channel.parent.name;
  }

  const payload = {
    event: 'reactionAdd',
    action: '追加',
    userName: reaction.message.guild?.members.cache.get(user.id)?.displayName || user.username,
    userId: user.id,
    emoji: reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name,
    messageId: reaction.message.id,
    messageContent: reaction.message.content || "[画像または埋め込みメッセージ]",
    category: categoryName
  };

  try {
    await axios.post(GAS_WEBHOOK_URL, payload);
  } catch (error) {
    console.error('GASへのスタンプ転送に失敗しました:', error.message);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch (error) { return console.error('リアクション取得失敗:', error); }
  }

  let categoryName = "なし";
  if (reaction.message.channel.parent) {
    categoryName = reaction.message.channel.parent.name;
  }

  const payload = {
    event: 'reactionRemove',
    action: '削除',
    userName: reaction.message.guild?.members.cache.get(user.id)?.displayName || user.username,
    userId: user.id,
    emoji: reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name,
    messageId: reaction.message.id,
    messageContent: reaction.message.content || "[画像または埋め込みメッセージ]",
    category: categoryName
  };

  try {
    await axios.post(GAS_WEBHOOK_URL, payload);
  } catch (error) {
    console.error('GASへのスタンプ削除転送に失敗しました:', error.message);
  }
});

// ===============================================================
// 🗑️ 機能3：メッセージ削除時の連動ログ削除
// ===============================================================
client.on('messageDelete', async (message) => {
  const payload = {
    event: 'messageDelete',
    messageId: message.id
  };

  try {
    await axios.post(GAS_WEBHOOK_URL, payload);
    console.log(`🗑️ メッセージ削除を検知。GAS側のログを削除しました。(ID: ${message.id})`);
  } catch (error) {
    console.error('GASへの削除イベント転送に失敗しました:', error.message);
  }
});

// ===============================================================
// 🌐 機能4：GASの「最重要一括同期ボタン」を受け付けるエンドポイント (/sync)
// ===============================================================
app.post('/sync', async (req, res) => {
  res.status(200).json({ status: "processing", message: "一括同期を開始します。" });
  console.log("🔄 GASからのリクエストにより、一括完全同期処理を開始します...");

  try {
    const guilds = client.guilds.cache;
    const allLogs = [];

    for (const [guildId, guild] of guilds) {
      const channels = await guild.channels.fetch();
      const textChannels = channels.filter(c => c.isTextBased());

      for (const [channelId, channel] of textChannels) {
        try {
          const messages = await channel.messages.fetch({ limit: 100 });
          for (const [messageId, message] of messages) {
            const reactions = message.reactions.cache;
            for (const [emojiId, reaction] of reactions) {
              const users = await reaction.users.fetch();
              for (const [userId, user] of users) {
                if (user.bot) continue;

                const member = await guild.members.fetch(userId).catch(() => null);
                const userName = member ? member.displayName : user.username;
                const emojiDisplay = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;

                allLogs.push({
                  timestamp: message.createdAt.toISOString(),
                  userName: userName,
                  userId: userId,
                  emoji: emojiDisplay,
                  action: '追加',
                  messageId: messageId,
                  messageContent: message.content || "（内容取得不可）"
                });
              }
            }
          }
        } catch (err) {
          // 閲覧権限のないチャンネル等はスキップ
        }
      }
    }

    await axios.post(GAS_WEBHOOK_URL, {
      event: 'bulkSync',
      data: allLogs
    });
    console.log(`✅ 一括同期が完了しました。総リアクション数: ${allLogs.length}件`);

  } catch (error) {
    console.error('一括同期処理中にエラーが発生しました:', error.message);
  }
});

// Renderのポート待受
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web Server listening on port ${PORT}`);
});

client.login(DISCORD_BOT_TOKEN);
