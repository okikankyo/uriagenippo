const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

const sessions = {};

const FIELDS = [
  { code: 'ちゃんぷるー', label: 'ちゃんぷるー' },
  { code: 'サーター屋', label: 'サーター屋' },
  { code: '入園口現金', label: '入園口現金' },
  { code: '入園口クーポン', label: '入園口クーポン' },
  { code: '玉那覇家', label: '玉那覇家' },
  { code: 'ポーポー屋', label: 'ポーポー屋' },
  { code: 'ドリンク', label: 'ドリンク' },
  { code: '体験会場', label: '体験会場' },
  { code: 'ハラペッコ', label: 'ハラペッコ' },
  { code: '治五郎', label: '治五郎' },
  { code: 'カメラ屋', label: 'カメラ屋' },
  { code: '真珠屋', label: '真珠屋' },
  { code: 'てぃだ屋', label: 'てぃだ屋' },
  { code: 'その他', label: 'その他' }
];

function normalizeNumber(text) {
  return Number(String(text || '').replace(/,/g, '').replace(/円/g, '').trim()) || 0;
}

function formatYen(n) {
  return '¥' + Number(n || 0).toLocaleString();
}

function parseDate(text) {
  const t = String(text || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  const m = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const year = jst.getUTCFullYear();
    return `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }

  return null;
}

function isAllowedChannel(channelId) {
  const allowed = (process.env.ALLOWED_CHANNEL_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  if (!allowed.length) return true;

  return allowed.includes(channelId);
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  const privateKey = (process.env.LW_PRIVATE_KEY || '')
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\\n/g, '\n')
    .trim();

  const assertion = jwt.sign(
    {
      iss: process.env.LW_CLIENT_ID,
      sub: process.env.LW_SERVICE_ACCOUNT,
      iat: now,
      exp: now + 300
    },
    privateKey,
    { algorithm: 'RS256' }
  );

  const params = new URLSearchParams();
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.append('client_id', process.env.LW_CLIENT_ID);
  params.append('client_secret', process.env.LW_CLIENT_SECRET);
  params.append('assertion', assertion);
  params.append('scope', 'bot bot.message');

  const res = await axios.post(
    'https://auth.worksmobile.com/oauth2/v2.0/token',
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data.access_token;
}

async function sendMessage(channelId, text) {
  const token = await getAccessToken();

  await axios.post(
    `https://www.worksapis.com/v1.0/bots/${process.env.LW_BOT_ID}/channels/${channelId}/messages`,
    {
      content: {
        type: 'text',
        text
      }
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

async function registerToKintone(data) {
  const record = {
    日付: { value: data.date }
  };

  let total = 0;

  FIELDS.forEach(field => {
    const value = Number(data.values[field.code] || 0);
    total += value;
    record[field.code] = { value };
  });

  await axios.post(
    `https://${process.env.KINTONE_SUBDOMAIN}.cybozu.com/k/v1/record.json`,
    {
      app: Number(process.env.KINTONE_APP_ID),
      record
    },
    {
      headers: {
        'X-Cybozu-API-Token': process.env.KINTONE_API_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );

  return total;
}

function startSession(userKey) {
  sessions[userKey] = {
    step: 'date',
    date: '',
    index: 0,
    values: {}
  };
}

function deleteSession(userKey) {
  delete sessions[userKey];
}

app.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log('📩 受信:', JSON.stringify(body));

    if (body.type === 'join' || body.type === 'joined') return;
    if (body.type !== 'message') return;
    if (body.content?.type !== 'text') return;

    const channelId = body.source?.channelId;
    const userId = body.source?.userId;

    if (!channelId || !userId) {
      console.log('channelId または userId なし');
      return;
    }

    if (!isAllowedChannel(channelId)) {
      await sendMessage(channelId, 'このBOTは指定された経理チャンネルでのみ利用できます。');
      return;
    }

    const userKey = `${channelId}:${userId}`;
    const text = body.content.text.trim();

    if (text === '開始' || text.toLowerCase() === 'start') {
      startSession(userKey);
      await sendMessage(
        channelId,
        `日付を入力してください。\n例：2026-04-01 または 4/1`
      );
      return;
    }

    if (text === 'キャンセル' || text.toLowerCase() === 'cancel') {
      deleteSession(userKey);
      await sendMessage(channelId, '入力をキャンセルしました。');
      return;
    }

    const session = sessions[userKey];

    if (!session) {
      await sendMessage(
        channelId,
        `デイリー売上入力を開始する場合は「開始」と送ってください。\n中止する場合は「キャンセル」です。`
      );
      return;
    }

    if (session.step === 'date') {
      const date = parseDate(text);

      if (!date) {
        await sendMessage(
          channelId,
          `日付形式が違います。\n例：2026-04-01 または 4/1`
        );
        return;
      }

      session.date = date;
      session.step = 'values';
      session.index = 0;

      await sendMessage(
        channelId,
        `${FIELDS[0].label}の売上を入力してください。`
      );
      return;
    }

    if (session.step === 'values') {
      const currentField = FIELDS[session.index];
      const value = normalizeNumber(text);

      session.values[currentField.code] = value;
      session.index += 1;

      if (session.index < FIELDS.length) {
        const nextField = FIELDS[session.index];

        await sendMessage(
          channelId,
          `${nextField.label}の売上を入力してください。`
        );
        return;
      }

      const total = await registerToKintone(session);

      await sendMessage(
        channelId,
        `✅ デイリー売上を登録しました\n\n日付：${session.date}\n合計：${formatYen(total)}`
      );

      deleteSession(userKey);
      return;
    }

  } catch (e) {
    console.error('❌ エラー:', e.response?.data || e.message);

    try {
      const channelId = req.body?.source?.channelId;
      if (channelId) {
        await sendMessage(channelId, '❌ エラーが発生しました。ログを確認してください。');
      }
    } catch {}
  }
});

app.get('/', (req, res) => {
  res.send('デイリー売上入力BOT 稼働中');
});

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 Server started');
});
