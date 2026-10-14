/**
 * Google Chat「やっときます」文案メーカー
 *
 * 5分おきに自分の Google Chat 投稿をチェックし、
 * 「やっときます」「送っときます」などの約束を見つけたら、
 * Claude で文案を作って自分の LINE に届ける。
 * 自分宛ての DM や @メンションで、返したほうがいいものにも返信案を届ける。
 */

const CONFIG = {
  MODEL: 'claude-haiku-5-5',
  // まずこの言葉を含む自分の投稿だけを候補にする（本当に約束かどうかは Claude が判定）
  KEYWORDS: /(てみます|お待ちください|お待ち下さい|確認中|後ほど|折り返し|改めて|やっと|やっておき|しとき|しておき|送っと|送っておき|入れとき|入れておき|上げとき|上げておき|直しと|直しておき|伝えと|伝えておき|作っと|作っておき|まとめと|まとめておき|調べと|調べておき|お願いしと|お願いしておき|させていただきます|させて頂きます|(送付|送信|確認|対応|共有|連絡|依頼|手配|調整|修正|作成|準備|提出|報告|相談|予約|返信|発注)(します|いたします|致します|しと|しておき)|(送り|作り|まとめ|調べ|伝え|やり|入れ|上げ|直し|進め|聞き|返し)ます)/,
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

const REPLY_PROMPT = `あなたは、社内チャットで自分宛てに来たメッセージへの返信を下書きするアシスタントです。

渡されるのは Google Chat の会話の抜粋です。「自分」がこの返信案を受け取る本人、「相手」はそれ以外の参加者です。「★」の付いた投稿が、今回チェックする相手からのメッセージです。

やること:
1. ★のメッセージに、自分が返信や対応をしたほうがいいかを判定する。
   - 返したほうがいい: 質問、お願い・依頼、確認や返事を求めている、日程調整、資料などを待っている。
   - 返さなくていい: お礼だけ、了解・承知だけ、ただのお知らせ、雑談の相づち、★より後に自分がもう返している。
2. 返したほうがいいなら、自分が返す文面を下書きする。
   - そのままチャットに送れる返信にする。
   - 自分にしか分からない答え（日時、数字、URL、可否など）は【　】で空欄にする。作り話で埋めない。
   - すぐ答えられない内容なら「確認して◯◯までにお返事します」のような一次返信にする。
   - 社内チャット向けの、丁寧すぎない自然な敬語で。会話の口調に合わせる。

出力は次の JSON だけにする（前後に説明やコードブロックを付けない）:
{
  "needs_reply": true または false,
  "task": "何を返すか（20字程度）",
  "to": "誰への返信か（分からなければ空文字）",
  "deadline": "会話に期限があれば。無ければ空文字",
  "draft": "返信の下書き",
  "note": "送る前に確認したほうがいいこと（無ければ空文字）"
}
返さなくていい場合は needs_reply を false にし、他は空文字でよい。`;

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
        const messages = listMessages_(space.name, { filter: timeFilter_(since, until), pageSize: 1000 });

        messages
          .filter(m => isMine_(m, me) && CONFIG.KEYWORDS.test(m.text || ''))
          .forEach(m => runSafely_(space, m, () => handleCommitment_(space, m, me)));

        // 自分宛ての DM・@メンションは、まとめて来ても一番新しいもの1つにだけ返信案を作る。
        // そのあと自分がもう返していれば作らない。
        const incoming = messages.filter(m => isForMe_(space, m, me));
        // 止まっていた間の古いメッセージにはさかのぼって作らない（1時間以内のものだけ）。
        const latest = incoming[incoming.length - 1];
        const recentEnough = latest && new Date(latest.createTime).getTime() > Date.now() - 60 * 60 * 1000;
        if (recentEnough && !messages.some(m => isMine_(m, me) && m.createTime > latest.createTime)) {
          runSafely_(space, latest, () => handleIncoming_(space, latest, me));
        }
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
  const result = askClaude_(conversation, SYSTEM_PROMPT);
  sendDraft_({ displayName: 'テスト' }, { text: '地図付けて今日中に送っときます' }, result, '【文案】', ['テストさん']);
  Logger.log(JSON.stringify(result, null, 2));
}

/** 返信案の動作確認用。手動で実行するとサンプルの返信案が LINE に届く。 */
function testReply() {
  const conversation = [
    '相手A: お疲れさまです！',
    '★相手A: 来週の打ち合わせ、20日の午後でご都合いかがでしょうか？難しければ候補日をいただけると助かります',
  ].join('\n');
  const result = askClaude_(conversation, REPLY_PROMPT);
  sendDraft_({ displayName: 'テスト' }, { text: '来週の打ち合わせ、20日の午後でご都合いかがでしょうか？' }, result, '【返信案】', ['テストさん']);
  Logger.log(JSON.stringify(result, null, 2));
}

function handleCommitment_(space, message, me) {
  const conv = buildConversation_(space, message, me);
  const result = askClaude_(conv.text, SYSTEM_PROMPT);
  if (result.is_commitment) {
    sendDraft_(space, message, result, '【文案】', conv.participants);
  }
}

function handleIncoming_(space, message, me) {
  const conv = buildConversation_(space, message, me);
  const result = askClaude_(conv.text, REPLY_PROMPT);
  if (result.needs_reply) {
    sendDraft_(space, message, result, '【返信案】', conv.participants);
  }
}

function runSafely_(space, message, fn) {
  try {
    fn();
  } catch (e) {
    notifyError_(space, message, e);
  }
}

function isMine_(message, me) {
  return message.sender && message.sender.name === me;
}

/** 人から自分宛てに来たメッセージか（DM・グループDM、または自分への @メンション）。 */
function isForMe_(space, message, me) {
  if (!message.sender || message.sender.name === me || message.sender.type === 'BOT') return false;
  if (space.spaceType === 'DIRECT_MESSAGE' || space.spaceType === 'GROUP_CHAT') return true;
  return (message.annotations || []).some(a =>
    a.type === 'USER_MENTION' && a.userMention && a.userMention.user && a.userMention.user.name === me);
}

/** 対象の投稿までの直前の会話を、「自分」「◯◯さん」の形で並べる。会話の相手の名前の一覧も返す。 */
function buildConversation_(space, message, me) {
  const sent = new Date(message.createTime).getTime();
  const from = new Date(sent - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(sent + 1).toISOString();
  const recent = listMessages_(space.name, { filter: timeFilter_(from, to), pageSize: 1000 }, 5)
    .slice(-CONFIG.CONTEXT_MESSAGES);

  const labels = {};
  const label = m => {
    const name = m.sender ? m.sender.name : '';
    if (name === me) return '自分';
    if (!labels[name]) {
      const real = displayNameOf_(name);
      labels[name] = real ? real + 'さん' : '相手' + String.fromCharCode(65 + Object.keys(labels).length);
    }
    return labels[name];
  };
  const lines = recent.map(m => (m.name === message.name ? '★' : '') + label(m) + ': ' + (m.text || '（テキストなし）'));
  if (!recent.some(m => m.name === message.name)) {
    lines.push('★' + label(message) + ': ' + message.text);
  }
  const participants = Object.keys(labels).map(k => labels[k]);
  const title = space.displayName || `${participants.join('、')}とのDM`;
  return { text: `スペース名: ${title}\n\n${lines.join('\n')}`, participants: participants };
}

/** Chat の users/{id} から社内名簿の名前を引く。引けなければ空文字（6時間キャッシュ）。 */
function displayNameOf_(userName) {
  if (!userName || !userName.startsWith('users/')) return '';
  const cache = CacheService.getScriptCache();
  const cached = cache.get(userName);
  if (cached !== null) return cached;
  let name = '';
  try {
    const person = People.People.get(userName.replace('users/', 'people/'), {
      personFields: 'names',
      sources: ['READ_SOURCE_TYPE_PROFILE', 'READ_SOURCE_TYPE_DOMAIN_CONTACT'],
    });
    name = (person.names && person.names[0] && person.names[0].displayName) || '';
  } catch (e) {
    console.warn(`名前を取得できませんでした (${userName}): ${e.message}`);
  }
  cache.put(userName, name, 6 * 60 * 60);
  return name;
}

/** チャットを開くリンク。 */
function chatUrl_(space) {
  if (space.spaceUri) return space.spaceUri;
  if (!space.name) return '';
  const id = space.name.replace('spaces/', '');
  return space.spaceType === 'DIRECT_MESSAGE' ? `https://chat.google.com/dm/${id}` : `https://chat.google.com/room/${id}`;
}

function askClaude_(conversation, systemPrompt) {
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
      system: systemPrompt,
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
function sendDraft_(space, message, result, heading, participants) {
  const others = (participants || []).join('、');
  const where = space.displayName ? `スペース「${space.displayName}」` : 'DM';
  let summary = `${heading}${result.task}\n\n`;
  summary += `やりとり：${others || '（名前を取得できませんでした）'}（${where}）\n`;
  summary += `送る相手：${result.to || '（会話から判断できませんでした）'}\n`;
  summary += `期限：${result.deadline || '未定'}\n`;
  if (result.note) summary += `※ ${result.note}\n`;
  summary += `\n元の発言：\n「${message.text}」`;
  const url = chatUrl_(space);
  if (url) summary += `\n\nチャットを開く：\n${url}`;
  notify_(`${heading}${result.task}`, [summary, result.draft]);
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

/** Chat API の時刻の絞り込みは create_time と「>」「<」だけが使える。 */
function timeFilter_(after, before) {
  return `create_time > "${after}" AND create_time < "${before}"`;
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

/** 調べる用：直近2時間の自分の投稿が読めているか、反応する言葉に当たるかを表示する（Claude と LINE は使わない）。 */
function debugRecent() {
  const props = PropertiesService.getScriptProperties();
  const me = fetchMyUserName_();
  Logger.log('自分のID（今取得）: %s', me);
  Logger.log('自分のID（保存済み）: %s', props.getProperty('MY_USER_NAME'));
  Logger.log('前回チェックした時刻: %s', props.getProperty('LAST_CHECK'));
  Logger.log('自動実行の数: %s', ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'checkChat').length);

  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();
  const spaces = listSpaces_();
  Logger.log('参加しているスペース・DMの数: %s', spaces.length);
  spaces
    .filter(space => !space.lastActiveTime || space.lastActiveTime > since)
    .forEach(space => {
      const messages = listMessages_(space.name, { filter: timeFilter_(since, until), pageSize: 1000 });
      const mine = messages.filter(m => m.sender && m.sender.name === me);
      Logger.log('■ %s（%s）: 投稿 %s件 / うち自分 %s件', space.displayName || 'DM', space.name, messages.length, mine.length);
      mine.forEach(m => Logger.log('   %s %s「%s」', CONFIG.KEYWORDS.test(m.text || '') ? '○反応する' : '×反応しない', m.createTime, (m.text || '').slice(0, 40)));
      if (messages.length && !mine.length) {
        Logger.log('   投稿者のID例: %s', messages.slice(0, 3).map(m => m.sender && m.sender.name).join(', '));
      }
    });
}
