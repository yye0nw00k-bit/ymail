'use strict';
/**
 * Ymail server — 외부 패키지 없이 Node 18+ 만으로 동작합니다.
 *  - 회원가입 / 로그인 (scrypt 해시, 서명된 HttpOnly 쿠키)
 *  - 관리자 계정 + 관리자 API
 *  - /api/search : 검색 API 프록시 (Tavily / SearXNG / Brave, 키는 서버에만 보관)
 *  - public/ 정적 파일 제공
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

/* ---------- .env 로드 ---------- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env 없음 */ }

const PORT = +process.env.PORT || 3000;
const DOMAIN = process.env.MAIL_DOMAIN || 'ymail.com';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MAIL_FILE = path.join(DATA_DIR, 'mail.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8'); }
  catch { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }
}

/* ---------- 사용자 저장소 (JSON 파일) ---------- */
let users = [];
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { /* 첫 실행 */ }
function saveUsers() {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function readStore(file, fallback = []) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}
function saveStore(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
let mailStore = readStore(MAIL_FILE);
let chatStore = readStore(CHAT_FILE);
function saveMail() { saveStore(MAIL_FILE, mailStore); }
function saveChat() { saveStore(CHAT_FILE, chatStore); }
function mailId() { return crypto.randomBytes(12).toString('hex'); }
function chatId() { return crypto.randomBytes(12).toString('hex'); }
function emailOf(username) { return `${username}@${DOMAIN}`; }
function findUserByEmail(address) {
  const a = String(address || '').trim().toLowerCase();
  return users.find(u => emailOf(u.username).toLowerCase() === a) || null;
}
function mailForUser(m, username) {
  return {
    id: m.id, from: m.from, addr: m.addr, to: m.to, subj: m.subj, body: m.body,
    time: m.time, read: !!m.read, star: !!m.star, folder: m.folder
  };
}
const findUser = (name) => users.find((u) => u.username === name);
const publicUser = (u) => ({ username: u.username, email: `${u.username}@${DOMAIN}`, name: u.name, role: u.role, createdAt: u.createdAt });

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(pw, salt, 64)).toString('hex');
  return { salt, hash };
}
async function checkPassword(pw, u) {
  const h = await scrypt(pw, u.salt, 64);
  const b = Buffer.from(u.hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(b, h);
}

/* ---------- 세션 토큰 (서명된 쿠키) ---------- */
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(username) {
  const p = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return p + '.' + sign(p);
}
function readToken(t) {
  if (!t) return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const good = sign(p);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o.u : null; }
  catch { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
function setSession(req, res, username) {
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ymail_session=${makeToken(username)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${secure}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'ymail_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}
function currentUser(req) {
  const name = readToken(parseCookies(req).ymail_session);
  return name ? findUser(name) || null : null;
}

/* ---------- 간단한 요청 제한 ---------- */
const buckets = new Map(); // key -> {n, until, reset}
function limited(key) {
  const b = buckets.get(key);
  return !!(b && b.until && b.until > Date.now());
}
function hit(key, max, lockMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || (b.reset && b.reset < now)) b = { n: 0, until: 0, reset: now + lockMs };
  b.n++;
  if (b.n >= max) b.until = now + lockMs;
  buckets.set(key, b);
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if ((b.reset || 0) < now && (b.until || 0) < now) buckets.delete(k); }, 60000).unref();
const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';

/* ---------- 유틸 ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('JSON 요청만 받을 수 있어요'), { status: 415 }));
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10 * 1024) { reject(Object.assign(new Error('요청이 너무 커요'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(Object.assign(new Error('잘못된 JSON이에요'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const normUsername = (s) => String(s || '').trim().toLowerCase().replace(new RegExp('@' + DOMAIN.replace(/\./g, '\\.') + '$'), '');
const RESERVED = new Set(['admin', 'administrator', 'root', 'postmaster', 'support', 'security', 'noreply', 'abuse', 'webmaster', 'ymail', 'yeole']);

/* ---------- 검색 (Tavily / SearXNG / Brave 중 설정된 것 사용) ---------- */
const searchCache = new Map();
const strip = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").trim();
const fail = (status, msg) => Object.assign(new Error(msg), { status });

function pickProvider() {
  const want = (process.env.SEARCH_PROVIDER || '').toLowerCase();
  const has = { tavily: !!process.env.TAVILY_API_KEY, searxng: !!process.env.SEARXNG_URL, brave: !!process.env.BRAVE_API_KEY };
  if (want && has[want]) return want;
  return ['tavily', 'searxng', 'brave'].find((p) => has[p]) || null;
}
async function callJson(url, init, who) {
  let r;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) }); }
  catch { throw fail(502, `${who} 검색 서버에 연결하지 못했어요. 잠시 후 다시 시도하세요.`); }
  if (r.status === 401 || r.status === 403) throw fail(502, `${who} API 키(또는 접근 권한)가 올바르지 않아요.`);
  if (r.status === 429 || r.status === 432 || r.status === 433) throw fail(429, `${who} 검색 한도를 넘었어요. 다음 달까지 기다리거나 다른 검색 서비스를 쓰세요.`);
  if (!r.ok) throw fail(502, `${who} 검색에 실패했어요 (${r.status})`);
  try { return await r.json(); } catch { throw fail(502, `${who} 응답을 읽지 못했어요.`); }
}
const providers = {
  async tavily(q) {
    const j = await callJson('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.TAVILY_API_KEY },
      body: JSON.stringify({ query: q, max_results: 10 }),
    }, 'Tavily');
    return (j.results || []).map((x) => ({ title: x.title, url: x.url, desc: x.content }));
  },
  async searxng(q) {
    const base = process.env.SEARXNG_URL.replace(/\/+$/, '');
    const u = new URL(base + '/search');
    u.searchParams.set('q', q); u.searchParams.set('format', 'json'); u.searchParams.set('language', 'ko');
    const j = await callJson(u, { headers: { Accept: 'application/json' } }, 'SearXNG');
    return (j.results || []).slice(0, 10).map((x) => ({ title: x.title, url: x.url, desc: x.content }));
  },
  async brave(q) {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', q); u.searchParams.set('count', '10');
    u.searchParams.set('country', 'KR'); u.searchParams.set('search_lang', 'ko');
    const j = await callJson(u, { headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY } }, 'Brave');
    return ((j.web && j.web.results) || []).map((x) => ({ title: x.title, url: x.url, desc: x.description }));
  },
};
async function webSearch(q) {
  const provider = pickProvider();
  if (!provider) throw fail(503, '검색 서비스가 설정되지 않았어요. .env 파일에 TAVILY_API_KEY(또는 SEARXNG_URL)를 넣고 서버를 다시 시작하세요.');
  const ck = provider + '|' + q.toLowerCase();
  const c = searchCache.get(ck);
  if (c && c.exp > Date.now()) return c.data;
  const raw = await providers[provider](q);
  const results = raw.map((x) => {
    let host = ''; try { host = new URL(x.url).hostname; } catch { /* ignore */ }
    return { title: strip(x.title), url: /^https?:\/\//i.test(x.url || '') ? x.url : '', host, desc: strip(x.desc).slice(0, 300) };
  }).filter((x) => x.url);
  const data = { query: q, results };
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(ck, { data, exp: Date.now() + 5 * 60 * 1000 });
  return data;
}

/* ---------- API 라우터 ---------- */
async function api(req, res, pathname, query) {
  const method = req.method;
  const ip = clientIp(req);

  if (pathname === '/api/signup' && method === 'POST') {
    if (limited('signup|' + ip)) return send(res, 429, { error: '가입 시도가 너무 많아요. 잠시 후 다시 시도하세요.' });
    const b = await readJson(req);
    const username = normUsername(b.username), name = String(b.name || '').trim().slice(0, 40), password = String(b.password || '');
    if (!/^[a-z0-9][a-z0-9._]{3,29}$/.test(username)) return send(res, 400, { error: '아이디는 영문 소문자, 숫자, 점(.), 밑줄(_)로 4~30자여야 해요.' });
    if (RESERVED.has(username)) return send(res, 400, { error: '사용할 수 없는 아이디예요.' });
    if (!name) return send(res, 400, { error: '이름을 입력하세요.' });
    if (password.length < 8 || password.length > 128) return send(res, 400, { error: '비밀번호는 8자 이상이어야 해요.' });
    if (password.toLowerCase().includes(username)) return send(res, 400, { error: '비밀번호에 아이디를 포함할 수 없어요.' });
    hit('signup|' + ip, 10, 3600e3);
    if (findUser(username)) return send(res, 409, { error: '이미 사용 중인 아이디예요.' });
    const { salt, hash } = await hashPassword(password);
    const u = { username, name, salt, hash, role: 'user', createdAt: new Date().toISOString() };
    users.push(u); saveUsers();
    setSession(req, res, username);
    return send(res, 201, { user: publicUser(u) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const b = await readJson(req);
    const username = normUsername(b.username), password = String(b.password || '');
    const k1 = 'login|' + ip + '|' + username, k2 = 'loginip|' + ip;
    if (limited(k1) || limited(k2)) return send(res, 429, { error: '로그인 시도가 너무 많아요. 15분 뒤에 다시 시도하세요.' });
    const u = findUser(username);
    // 존재하지 않는 계정도 같은 시간이 걸리도록 해시 계산
    const ok = u ? await checkPassword(password, u) : (await scrypt(password, 'x'.repeat(32), 64), false);
    if (!ok) { hit(k1, 5, 15 * 60e3); hit(k2, 30, 15 * 60e3); return send(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않아요.' }); }
    buckets.delete(k1);
    setSession(req, res, u.username);
    return send(res, 200, { user: publicUser(u) });
  }

  if (pathname === '/api/logout' && method === 'POST') { clearSession(res); return send(res, 200, { ok: true }); }

  const me = currentUser(req);
  if (pathname === '/api/me' && method === 'GET') return me ? send(res, 200, { user: publicUser(me) }) : send(res, 401, { error: '로그인이 필요해요.' });
  if (!me) return send(res, 401, { error: '로그인이 필요해요.' });



  if (pathname === '/api/ai' && method === 'POST') {
    if (limited('yeol-ai|' + me.username)) return send(res, 429, { error: 'AI 요청이 너무 많아요. 잠시 후 다시 시도하세요.' });
    hit('yeol-ai|' + me.username, 20, 60e3);

    const b = await readJson(req);
    const action = String(b.action || 'chat');
    const message = String(b.message || '').trim().slice(0, 4000);
    const subject = String(b.subject || '').trim().slice(0, 200);
    const mailBody = String(b.mailBody || '').trim().slice(0, 6000);
    const context = String(b.context || '').slice(0, 8000);

    if (!['chat','draft','summarize'].includes(action)) return send(res,400,{error:'잘못된 AI 작업이에요.'});
    if (action !== 'summarize' && !message) return send(res,400,{error:'내용을 입력하세요.'});
    if (action === 'summarize' && !mailBody) return send(res,400,{error:'요약할 메일이 없어요.'});

    const key = process.env.GEMINI_API_KEY;
    if (!key) return send(res,503,{error:'Render 환경변수 GEMINI_API_KEY가 설정되지 않았어요.'});

    let prompt;
    if(action==='summarize'){
      prompt='Ymail의 한국어 이메일 요약 비서 Yeol AI입니다. 메일의 핵심 내용, 요청사항, 날짜와 중요한 정보를 정확하게 요약하세요. 없는 사실을 만들지 마세요.\n제목: '+subject+'\n메일 내용:\n'+mailBody;
    }else if(action==='draft'){
      prompt='Ymail의 이메일 작성 도우미 Yeol AI입니다. 사용자의 요청에 맞춰 자연스럽고 정중한 한국어 이메일 본문만 작성하세요. 제목이나 설명은 쓰지 마세요.\n받는 사람: '+String(b.recipient||'').slice(0,200)+'\n기존 제목: '+subject+'\n사용자 요청: '+message+'\n참고 내용:\n'+mailBody+'\n'+context;
    }else{
      prompt='당신은 Ymail의 AI 비서 Yeol AI입니다. 한국어로 친절하고 유용하게 답하세요. 제공된 메일 문맥을 활용하되, 모르는 사실은 추측하지 마세요.\n사용자 질문: '+message+'\n메일 문맥:\n'+context;
    }

    let response;
    try{
      response=await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(process.env.GEMINI_MODEL||'gemini-3.8-flash')+':generateContent',
        {
          method:'POST',
          headers:{'Content-Type':'application/json','x-goog-api-key':key},
          body:JSON.stringify({
            contents:[{parts:[{text:prompt}]}],
            generationConfig:{maxOutputTokens:1200}
          }),
          signal:AbortSignal.timeout(30000)
        }
      );
    }catch{
      return send(res,502,{error:'Gemini 서버에 연결하지 못했어요.'});
    }

    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      const msg=(data.error&&data.error.message)||'Gemini 요청에 실패했어요.';
      const status=response.status===429?429:(response.status===400?400:502);
      return send(res,status,{error:msg});
    }

    const answer=(data.candidates||[])
      .flatMap(c=>c.content&&c.content.parts||[])
      .filter(p=>p.text)
      .map(p=>p.text)
      .join('\n')
      .trim();

    if(!answer) return send(res,502,{error:'Gemini가 빈 답변을 반환했어요.'});
    return send(res,200,{answer:answer.slice(0,12000)});
  }

  if (pathname === '/api/users' && method === 'GET') {
    const q = String(query.get('q') || '').trim().toLowerCase().slice(0, 50);
    const result = users
      .filter(u => u.username !== me.username)
      .filter(u => !q || u.username.includes(q) || u.name.toLowerCase().includes(q) || emailOf(u.username).toLowerCase().includes(q))
      .map(publicUser);
    return send(res, 200, { users: result });
  }

  if (pathname === '/api/mail' && method === 'GET') {
    const items = mailStore
      .filter(m => m.owner === me.username)
      .sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(m => mailForUser(m, me.username));
    return send(res, 200, { mails: items });
  }

  if (pathname === '/api/mail/send' && method === 'POST') {
    const b = await readJson(req);
    const to = String(b.to || '').trim().toLowerCase();
    const subj = String(b.subj || '').trim().slice(0, 200);
    const bodyText = String(b.body || '').trim().slice(0, 10000);
    if (!/^\S+@\S+\.\S+$/.test(to)) return send(res, 400, { error: '받는 사람 이메일 주소가 올바르지 않아요.' });
    if (!bodyText) return send(res, 400, { error: '메일 내용을 입력하세요.' });
    const recipient = findUserByEmail(to);
    if (!recipient) return send(res, 404, { error: 'Ymail에 가입한 사용자의 이메일만 보낼 수 있어요.' });
    const now = new Date().toISOString();
    const pair = mailId();
    const fromAddr = emailOf(me.username);
    mailStore.push({ id: pair+'-s', owner: me.username, folder: 'sent', from: '나', addr: fromAddr, to: emailOf(recipient.username), toName: recipient.name, subj, body: bodyText, time: '방금', read: true, star: false, createdAt: now, pair });
    mailStore.push({ id: pair+'-r', owner: recipient.username, folder: 'inbox', from: me.name, addr: fromAddr, to: emailOf(recipient.username), subj, body: bodyText, time: '방금', read: false, star: false, createdAt: now, pair });
    saveMail();
    return send(res, 201, { ok: true });
  }

  if (pathname === '/api/mail/read' && method === 'POST') {
    const b = await readJson(req); const m = mailStore.find(x => x.id === b.id && x.owner === me.username);
    if (!m) return send(res, 404, { error: '메일을 찾을 수 없어요.' });
    m.read = true; saveMail(); return send(res, 200, { ok: true });
  }

  if (pathname === '/api/mail/star' && method === 'POST') {
    const b = await readJson(req); const m = mailStore.find(x => x.id === b.id && x.owner === me.username);
    if (!m) return send(res, 404, { error: '메일을 찾을 수 없어요.' });
    m.star = !!b.star; saveMail(); return send(res, 200, { ok: true });
  }

  if (pathname === '/api/mail/move-trash' && method === 'POST') {
    const b = await readJson(req); const m = mailStore.find(x => x.id === b.id && x.owner === me.username);
    if (!m) return send(res, 404, { error: '메일을 찾을 수 없어요.' });
    if (m.folder === 'trash') mailStore = mailStore.filter(x => x !== m); else m.folder = 'trash';
    saveMail(); return send(res, 200, { ok: true });
  }

  if (pathname === '/api/chat/people' && method === 'GET') {
    const q = String(query.get('q') || '').trim().toLowerCase().slice(0,50);
    const result = users.filter(u => u.username !== me.username)
      .filter(u => !q || u.username.includes(q) || u.name.toLowerCase().includes(q))
      .map(publicUser);
    return send(res, 200, { users: result });
  }

  if (pathname === '/api/chat' && method === 'GET') {
    const withUser = normUsername(query.get('with'));
    const other = findUser(withUser);
    if (!other || other.username === me.username) return send(res, 400, { error: '대화 상대를 찾을 수 없어요.' });
    const items = chatStore.filter(m => (m.from === me.username && m.to === other.username) || (m.from === other.username && m.to === me.username));
    return send(res, 200, { messages: items });
  }

  if (pathname === '/api/chat' && method === 'POST') {
    const b = await readJson(req); const to = normUsername(b.to); const bodyText = String(b.body || '').trim().slice(0,4000);
    const other = findUser(to);
    if (!other || other.username === me.username) return send(res, 404, { error: '대화 상대를 찾을 수 없어요.' });
    if (!bodyText) return send(res, 400, { error: '메시지를 입력하세요.' });
    const msg = { id: chatId(), from: me.username, fromName: me.name, to: other.username, toName: other.name, body: bodyText, createdAt: new Date().toISOString() };
    chatStore.push(msg); saveChat();
    return send(res, 201, { message: msg });
  }

  if (pathname === '/api/search' && method === 'GET') {
    const q = String(query.get('q') || '').trim().slice(0, 200);
    if (!q) return send(res, 400, { error: '검색어를 입력하세요.' });
    if (limited('search|' + me.username)) return send(res, 429, { error: '검색을 너무 자주 하고 있어요. 잠시 후 다시 시도하세요.' });
    hit('search|' + me.username, 30, 60e3);
    return send(res, 200, await webSearch(q));
  }

  if (pathname.startsWith('/api/admin/')) {
    if (me.role !== 'admin') return send(res, 403, { error: '관리자만 사용할 수 있어요.' });
    if (pathname === '/api/admin/users' && method === 'GET') return send(res, 200, { users: users.map(publicUser) });
    const m = pathname.match(/^\/api\/admin\/users\/([a-z0-9._]+)$/);
    if (m && method === 'DELETE') {
      const t = findUser(m[1]);
      if (!t) return send(res, 404, { error: '없는 사용자예요.' });
      if (t.username === me.username) return send(res, 400, { error: '자기 자신은 삭제할 수 없어요.' });
      users = users.filter((u) => u !== t); saveUsers();
      mailStore = mailStore.filter(m => m.owner !== t.username && m.fromUser !== t.username && m.toUser !== t.username); saveMail();
      chatStore = chatStore.filter(m => m.from !== t.username && m.to !== t.username); saveChat();
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: '없는 API예요.' });
}

/* ---------- 정적 파일 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let rel; try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname, url.searchParams);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e && e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: '서버 오류가 발생했어요.' });
  }
});

/* ---------- 관리자 계정 생성 ---------- */
(async () => {
  const an = normUsername(process.env.ADMIN_USERNAME), ap = process.env.ADMIN_PASSWORD;
  if (an && ap && !findUser(an)) {
    const { salt, hash } = await hashPassword(ap);
    users.push({ username: an, name: '관리자', salt, hash, role: 'admin', createdAt: new Date().toISOString() });
    saveUsers();
    console.log(`관리자 계정을 만들었어요: ${an}@${DOMAIN}`);
  }
  server.listen(PORT, () => {
    console.log(`Ymail 실행 중 → http://localhost:${PORT}`);
    console.log(pickProvider() ? `검색 서비스: ${pickProvider()}` : '참고: 검색 서비스(TAVILY_API_KEY 등)가 설정되지 않아 검색은 아직 동작하지 않아요.');
  });
})();
