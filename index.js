const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// 環境変数からトークンとGASのURLを読み込み
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ]
});

// GASから設定（ID）を取得するための変数
let TRIGGER_VC_ID = "";
let CATEGORY_ID = "";

// 作成された臨時VCを追跡するマップ (チャンネルID => 番号)
const createdVoiceChannels = new Map();

// サーバー生存確認用のエンドポイント
app.get('/', (req, res) => {
  res.send('Discord Bot is running!');
});

// Botの起動
client.once('ready', async () => {
  console.log(`🤖 Botが正常に起動しました: ${client.user.tag}`);
  
  // 起動時にGASから設定（ID情報）を自動取得
  try {
    const response = await axios.post(GAS_WEBHOOK_URL, { action: "vc_config" });
    TRIGGER_VC_ID = response.data.triggerVcId;
    CATEGORY_ID = response.data.categoryId;
    console.log(`📡 GASから設定を読み込みました。トリガーVC: ${TRIGGER_VC_ID}`);
  } catch (error) {
    console.error("❌ GASからの設定取得に失敗しました:", error.message);
  }
});

// ==========================================
// 【修正】VCチャンネル自動作成＆削除ロジック（連番・最大25部屋）
// ==========================================
client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member;
  if (!member || member.user.bot) return;

  // 1. ユーザーがトリガーVCに入室した場合
  if (newState.channelId === TRIGGER_VC_ID && oldState.channelId !== TRIGGER_VC_ID) {
    try {
      const guild = newState.guild;

      // 現在使われている番号（1〜25）を調査
      const usedNumbers = new Set(createdVoiceChannels.values());
      
      // 1から順に空いている番号を探す
      let nextNumber = -1;
      for (let i = 1; i <= 25; i++) {
        if (!usedNumbers.has(i)) {
          nextNumber = i;
          break;
        }
      }

      // もし25部屋すべて埋まっていたら作成しない
      if (nextNumber === -1) {
        console.log("⚠️ 最大部屋数（25部屋）に達しているため、新規作成をスキップしました。");
        // トリガーVCから一般のロビーなどへ戻す処理などを入れる場合はここに書きますが、一旦ログのみ
        return;
      }

      // 新しいチャンネル名（例: 自動VC-1）
      const channelName = `自動VC-${nextNumber}`;

      // 臨時VCの作成
      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: CATEGORY_ID,
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
    
    // その部屋がBotが作った臨時VC一覧に存在し、かつメンバーが0人になった場合
    if (createdVoiceChannels.has(oldState.channelId) && oldChannel && oldChannel.members.size === 0) {
      try {
        const number = createdVoiceChannels.get(oldState.channelId);
        await oldChannel.delete('臨時VCに誰もいなくなったため自動削除');
        createdVoiceChannels.delete(oldState.channelId); // マップから削除（番号が解放される）
        console.log(`🗑️ 誰もいなくなったため 自動VC-${number} を削除しました。`);
      } catch (error) {
        console.error('❌ 臨時VCの削除に失敗しました:', error);
      }
    }
  }
});

// ==========================================
// スタンプ（リアクション）ログ転送ロジック
// ==========================================
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('リアクションの取得に失敗しました:', error);
      return;
    }
  }

  const message = reaction.message;
  const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;

  let categoryName = "なし";
  if (message.channel.parent) {
    categoryName = message.channel.parent.name;
  }

  const payload = {
    action: "add_stamp",
    timestamp: timestamp,
    messageId: message.id,
    username: user.username,
    emoji: emoji,
    category: categoryName,
    content: message.content || "[画像または埋め込みメッセージ]"
  };

  try {
    await axios.post(GAS_WEBHOOK_URL, payload);
  } catch (error) {
    console.error('GASへのスタンプ転送に失敗しました:', error.message);
  }
});

// メッセージ削除時の連動削除
client.on('messageDelete', async (message) => {
  const payload = {
    action: "delete_message",
    messageId: message.id
  };

  try {
    await axios.post(GAS_WEBHOOK_URL, payload);
    console.log(`🗑️ メッセージ削除を検知。GAS側のログを削除しました。(ID: ${message.id})`);
  } catch (error) {
    console.error('GASへの削除イベント転送に失敗しました:', error.message);
  }
});

// Renderのポート待受（これがないとRenderでエラーになります）
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web Server listening on port ${PORT}`);
});

client.login(DISCORD_BOT_TOKEN);
