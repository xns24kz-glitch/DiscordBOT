const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const express = require('express');
const axios = require('axios');

// ===============================================================
// 🛠️ 設定エリア：あなたの環境に合わせてIDを書き換えてください
// ===============================================================
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN || "ここにあなたのBotのトークン（またはReplitのSecretsを使用）";
const GAS_WEBHOOK_URL = "https://script.google.com/macros/s/.../exec"; // あなたのGASのWebアプリURL

// 👇 臨時VCの起点となるチャンネルIDとカテゴリID
const TRIGGER_VC_ID = "552112398626979841";
const CATEGORY_ID = "1525454867316084857";

// ===============================================================
// 🏗️ Bot初期化
// ===============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// 作成された臨時VCのIDを一時保持する記憶エリア
const tempChannels = new Set();

client.once('ready', () => {
  console.log(`🤖 Botが正常に起動しました: ${client.user.tag}`);
});

// ===============================================================
// 🔄 機能1：リアクション追加・削除を検知してGASへ送信
// ===============================================================
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch (error) { return console.error('リアクション取得失敗:', error); }
  }
  sendToGas({
    event: 'reactionAdd',
    action: '追加',
    userName: reaction.message.guild?.members.cache.get(user.id)?.displayName || user.username,
    userId: user.id,
    emoji: reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name,
    messageId: reaction.message.id,
    messageContent: reaction.message.content || "（内容取得不可）"
  });
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch (error) { return console.error('リアクション取得失敗:', error); }
  }
  sendToGas({
    event: 'reactionRemove',
    action: '削除',
    userName: reaction.message.guild?.members.cache.get(user.id)?.displayName || user.username,
    userId: user.id,
    emoji: reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name,
    messageId: reaction.message.id,
    messageContent: reaction.message.content || "（内容取得不可）"
  });
});

// ===============================================================
// 🗑️ 機能2：Discord側でメッセージが削除されたらGAS側も連動削除
// ===============================================================
client.on('messageDelete', async (message) => {
  sendToGas({
    event: 'messageDelete',
    messageId: message.id
  });
});

// GASへのデータ送信関数
async function sendToGas(payload) {
  try {
    await axios.post(GAS_WEBHOOK_URL, payload);
  } catch (error) {
    console.error('GASへのデータ送信中にエラーが発生しました:', error.message);
  }
}

// ===============================================================
// 🔊 機能3：臨時VCの自動生成＆自動消去（特製ユーモア命名）
// ===============================================================
client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member;
  if (!member || member.user.bot) return;

  // 1️⃣ 【入室検知】ユーザーがトリガーVC（部屋を作る）に入室した場合
  if (newState.channelId === TRIGGER_VC_ID) {
    try {
      const guild = newState.guild;

      // ✨【超パワーアップ】指定ワード ＋ ランダム20個の特製部屋名テンプレート！
      const funnyTemplates = [
        // 👇 ご指定のワードベースのテンプレート
        `🔊 鯛人たち`,
        `🔊 ${member.displayName}「DEはねぇ～強いんですよ」`,
        `🔊 歯茎ｸﾞｷｸﾞｷｸﾞｷ部屋`,
        `🔊 窃盗犯デニスに警戒する${member.displayName}`,
        `🔊 ${member.displayName}が主催する深夜の飲酒フットサル会場`,

        // 👇 ランダムに生成したユーモアテンプレート20個
        `🔊 ${member.displayName}がただただ息を引き取る空間`,
        `🔊 ${member.displayName}が現実逃避をするための隔離病棟`,
        `🔊 ${member.displayName}の限界ネトゲ廃人養成所`,
        `🔊 ${member.displayName}が無限に寝言を供述する部屋`,
        `🔊 ${member.displayName}が絶叫しながら反省する独房`,
        `🔊 ${member.displayName}の生存報告会場（安否確認用）`,
        `🔊 ${member.displayName}のIQが一時的に3になる部屋`,
        `🔊 ${member.displayName}が世界の中心でバグを叫ぶ部屋`,
        `🔊 ${member.displayName}が人知れず虚無と戦うシェルター`,
        `🔊 本日の${member.displayName}の給水所（水分補給）`,
        `🔊 ${member.displayName}のあきらめたらそこで試合終了VC`,
        `🔊 ${member.displayName}による有識者会議（なお議題は未定）`,
        `🔊 ${member.displayName}がすべての責任を押し付ける部屋`,
        `🔊 ${member.displayName}の1ギガの通信制限との戦い`,
        `🔊 【朗報】${member.displayName}がやる気を出した部屋`,
        `🔊 【悲報】${member.displayName}がすでに満身創痍な部屋`,
        `🔊 ${member.displayName}のただ座っているだけで褒められる席`,
        `🔊 ${member.displayName}が裏でコソコソ育成している空間`
      ];

      // ランダムで1つフレーズを選択
      const randomIndex = Math.floor(Math.random() * funnyTemplates.length);
      const channelName = funnyTemplates[randomIndex];

      // 新しいボイスチャンネルを作成
      const newChannel = await guild.channels.create({
        name: channelName,
        type: 2, // 2 はボイスチャンネル
        parent: CATEGORY_ID || null,
        bitrate: 96000 // ブーストLv3環境用（高音質）
      });

      // 作成したチャンネルIDを記憶リストに登録
      tempChannels.add(newChannel.id);

      // ユーザーを作成した新しいVCへ強制移動
      await member.voice.setChannel(newChannel);
      console.log(`[VC作成] 面白部屋名を生成しました: ${channelName}`);

    } catch (error) {
      console.error('臨時VCの自動作成、またはメンバー移動中にエラーが発生しました:', error);
    }
  }

  // 2️⃣ 【退室検知】ユーザーが臨時VCから切断、または別の部屋に移動した場合
  if (oldState.channelId && tempChannels.has(oldState.channelId)) {
    const oldChannel = oldState.channel;

    // 中に残っているメンバーが 0人（空っぽ）になった場合
    if (oldChannel && oldChannel.members.size === 0) {
      try {
        await oldChannel.delete();
        tempChannels.delete(oldState.channelId); // 記憶リストから削除
        console.log(`[VC削除] 誰もいなくなったため、臨時VC「${oldChannel.name}」を自動削除しました。`);
      } catch (error) {
        console.error('臨時VCの自動削除中にエラーが発生しました:', error);
      }
    }
  }
});

// ===============================================================
// 🌐 Expressサーバーの構築（GASからの「一括完全同期」リクエストを受付）
// ===============================================================
const app = express();
app.use(express.json());

app.post('/sync', async (req, res) => {
  res.status(200).json({ status: "processing", message: "一括同期を開始します。" });
  console.log("🔄 GASからのリクエストにより、超・一括完全同期処理を開始します...");

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
          // スキップ
        }
      }
    }

    await axios.post(GAS_WEBHOOK_URL, {
      event: 'bulkSync',
      data: allLogs
    });
    console.log(`✅ 一括同期が完了しました。総リアクション数: ${allLogs.length}件`);

  } catch (error) {
    console.error('一括同期処理中に致命的なエラーが発生しました:', error.message);
  }
});

app.get('/', (req, res) => {
  res.send('Bot is running and voice tracking is active!');
});

app.listen(3000, () => {
  console.log('🌐 Web Server listening on port 3000');
});

client.login(DISCORD_BOT_TOKEN);
