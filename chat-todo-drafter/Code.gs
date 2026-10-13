/**
 * Google Chat「やっときます」文案メーカー
 *
 * 5分おきに自分の Google Chat 投稿をチェックし、
 * 「やっときます」「送っときます」などの約束を見つけたら、
 * Claude で文案を作って自分の LINE に届ける。
 */

const CONFIG = {
  MODEL: 'claude-haiku-5-5',
  // まずこの言葉を含む自分の投稿だけを候補にする（本当に約束かどうかは Claude が判定）
  KEYWORDS: /(やっと|やっておき|しとき|しておき|送っと|送っておき|送ります|送付します|共有します|共有しと|共有しておき|確認します|確認しと|確認しておき|対応します|対応しと|対応しておき|作ります|作っと|作っておき|まとめます|まとめと|まとめておき|連絡します|連絡しと|連絡しておき|調べます|調べと|調べておき|手配します|手配しと|手配しておき|入れとき|入れておき|上げとき|上げておき|修正します|直しと|直しておき|予約しと|予約しておき|お願いしと|伝えと|伝えておき|伝えます)/,
  // 文案づくりに渡す、直前の会話の件数
  CONTEXT_MESSAGES: 15,
  // 何分おきにチェックするか（1, 5, 10, 15, 30 のどれか）
  INTERVAL_MINUTES: 5,
};

const SYSTEM_PROMPT = `あなたは、社内チャットで「やっときます」「送っときます」と引き受けた人の代わりに、次に送る文面を下書きするアシスタントです。

渡されるのは Google Chat の会話の抜粋です。「自分」がこの文案を受け取る本人、「相手」はそれ以外の参加者です。最後の「★」の付いた投稿が、今回チェックする自分の投稿です。

やること:
1. ★の投稿が、自分が何かを引き受けた（これからやる・送る・確認する等）発言かを判定する。単なる相づちや、すでに終わったことの報告なら約束ではない。
2. 約束なら、その用事を片づけるときに送る文面を下書きする。
   - 「送っときます」系: 送る相手に向けた本文（メールやチャットでそのまま送れるもの）。
   - 「やっときます」「確認します」系: 終わったときにこのチャットへ返す完了報告。
   - 中身が自分にしか分からない部分（数字、URL、日付など）は【　】で空欄にする。作り話で埋めない。
   - 社内チャット向けの、丁寧すぎない自然な敬語で。会話の口調に合わせる。

出力は次の JSON だけにする（前後に説明やコードブロックを付けない）:
{
  "is_commitment": true または false,
  "task": "何をやるか（20字程度）",
  "to": "誰に向けた文面か（分からなければ空文字）",
  "deadline": "会話に期限があれば。無ければ空文字",
  "draft": "下書きの文面",
  "note": "送る前に確認したほうがいいこと（無ければ空文字）"
}
約束でない場合は is_commitment を false にし、他は空文字でよい。`;

/** 最初に1回だけ手動で実行する。権限の許可と、定期実行の登録をする。 */
function setup() {
  const missing = ['ANTHROPIC_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_USER_ID']
    .filter(k => !PropertiesService.getScriptProperties().getProperty(k));
  if (missing.length) {
    throw new Error(`スクリプト プロパティに ${missing.join(', ')} を設定してから実行してください。`);
  }
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkChat')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkChat').timeBased().everyMinutes(CONFIG.INTERVAL_MINUTES).create();

  const props = PropertiesService.getScriptProperties();
  props.setProperty('MY_USER_NAME', fetchMyUserName_());
  props.setProperty('LAST_CHECK', new Date().toISOString());
  Logger.log('セットアップ完了。これから %s 分おきにチェックします。', CONFIG.INTERVAL_MINUTES);
}

/** 自動実行を止めたいときに実行する。 */
function stop() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkChat')
    .forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('自動実行を止めました。');
}

/** 定期実行される本体。 */
function checkChat() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const since = props.getProperty('LAST_CHECK')
      || new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const until = new Date().toISOString();
    const me = props.getProperty('MY_USER_NAME') || fetchMyUserName_();

    listSpaces_()
      .filter(space => !space.lastActiveTime || space.lastActiveTime > since)
      .forEach(space => {
        const filter = `createTime > "${since}" AND createTime <= "${until}"`;
        listMessages_(space.name, { filter: filter, orderBy: 'createTime asc', pageSize: 100 })
          .filter(m => m.sender && m.sender.name === me && CONFIG.KEYWORDS.test(m.text || ''))
          .forEach(m => {
            try {
              handleCommitment_(space, m, me);
            } catch (e) {
              notifyError_(space, m, e);
            }
          });
      });

    props.setProperty('LAST_CHECK', until);
  } finally {
    lock.releaseLock();
  }
}

/** API キーと文案づくりの動作確認用。手動で実行するとサンプルの文案が LINE に届く。 */
function testDraft() {
  const conversation = [
    '相手: 来週の講習の案内、参加者の皆さんにもう送りましたっけ？',
    '相手: 会場の地図も一緒に付けてもらえると助かります',
    '★自分: まだでした！地図付けて今日中に送っときます',
  ].join('\n');
  const result = askClaude_(conversation);
  sendDraft_({ displayName: 'テスト' }, { text: '地図付けて今日中に送っときます' }, result);
  Logger.log(JSON.stringify(result, null, 2));
}

function handleCommitment_(space, message, me) {
  const result = askClaude_(buildConversation_(space, message, me));
  if (result.is_commitment) {
    sendDraft_(space, message, result);
  }
}

/** 対象の投稿までの直前の会話を、「自分」「相手」の形で並べる。 */
function buildConversation_(space, message, me) {
  const from = new Date(new Date(message.createTime).getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const filter = `createTime > "${from}" AND createTime <= "${message.createTime}"`;
  const recent = listMessages_(space.name, {
    filter: filter, orderBy: 'createTime desc', pageSize: CONFIG.CONTEXT_MESSAGES,
  }, 1).reverse();

  const labels = {};
  const label = m => {
    const name = m.sender ? m.sender.name : '';
    if (name === me) return '自分';
    if (!labels[name]) labels[name] = '相手' + String.fromCharCode(65 + Object.keys(labels).length);
    return labels[name];
  };
  const lines = recent.map(m => (m.name === message.name ? '★' : '') + label(m) + ': ' + (m.text || '（テキストなし）'));
  if (!recent.some(m => m.name === message.name)) {
    lines.push('★自分: ' + message.text);
  }
  const title = space.displayName || 'DM';
  return `スペース名: ${title}\n\n${lines.join('\n')}`;
}

function askClaude_(conversation) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: CONFIG.MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: conversation }],
    }),
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Claude API エラー (${res.getResponseCode()}): ${res.getContentText()}`);
  }
  const body = JSON.parse(res.getContentText());
  if (body.stop_reason === 'refusal') {
    throw new Error('Claude が回答を控えました。');
  }
  const text = body.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

/** 1通目に概要、2通目に文案だけを送る（長押しで文案だけコピーできるように）。 */
function sendDraft_(space, message, result) {
  let summary = `【文案】${result.task}\n`;
  if (result.to) summary += `宛先：${result.to}\n`;
  summary += `期限：${result.deadline || '未定'}\n`;
  if (result.note) summary += `※ ${result.note}\n`;
  summary += `\n元の発言（${space.displayName || 'DM'}）：\n「${message.text}」`;
  if (space.spaceUri) summary += `\n${space.spaceUri}`;
  notify_(`【文案】${result.task}`, [summary, result.draft]);
}

function notifyError_(space, message, error) {
  console.error(error);
  notify_('【文案】作成に失敗しました', [
    `文案を作れませんでした。\n\n「${message.text}」（${space.displayName || 'DM'}）\n\nエラー: ${error.message}`,
  ]);
}

/** LINE に送る。LINE に送れなかったときは取りこぼさないようメールで送る。 */
function notify_(subject, texts) {
  try {
    pushLine_(texts);
  } catch (e) {
    console.error(e);
    MailApp.sendEmail({
      to: Session.getActiveUser().getEmail(),
      subject: subject,
      body: texts.join('\n\n────────────\n\n') + `\n\n（LINE に送れなかったためメールで送りました: ${e.message}）`,
    });
  }
}

function pushLine_(texts) {
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + props.getProperty('LINE_CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify({
      to: props.getProperty('LINE_USER_ID'),
      // LINE の1吹き出しは5000文字まで
      messages: texts.map(t => ({ type: 'text', text: String(t).slice(0, 5000) })),
    }),
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`LINE API エラー (${res.getResponseCode()}): ${res.getContentText()}`);
  }
}

/** Chat の users/{id} は People API の people/{id} と同じ ID。 */
function fetchMyUserName_() {
  const me = People.People.get('people/me', { personFields: 'names' });
  return me.resourceName.replace('people/', 'users/');
}

function listSpaces_() {
  const spaces = [];
  let pageToken;
  do {
    const res = Chat.Spaces.list({ pageSize: 1000, pageToken: pageToken });
    (res.spaces || []).forEach(s => spaces.push(s));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return spaces;
}

function listMessages_(spaceName, options, maxPages) {
  const messages = [];
  let pageToken;
  let pages = 0;
  do {
    const res = Chat.Spaces.Messages.list(spaceName, Object.assign({}, options, { pageToken: pageToken }));
    (res.messages || []).forEach(m => messages.push(m));
    pageToken = res.nextPageToken;
    pages++;
  } while (pageToken && (!maxPages || pages < maxPages));
  return messages;
}
