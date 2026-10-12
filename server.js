'use strict';
// Yeole Mail + yeole 국어사전
/**
 * Ymail server — 외부 패키지 없이 Node 18+ 만으로 동작합니다.
 *  - 회원가입 / 로그인 (scrypt 해시, 서명된 HttpOnly 쿠키)
 *  - 관리자 계정 + 관리자 API
 *  - yeole 국어사전: 공식 단어 / 비공식 오픈사전
 *  - /api/search : 검색 API 프록시 (Tavily / SearXNG / Brave, 키는 서버에만 보관)
 *  - public/ 정적 파일 제공
 */
const http = require('http');
const https = require('https');
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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MAIL_FILE = path.join(DATA_DIR, 'mail.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const DICTIONARY_FILE = path.join(DATA_DIR, 'dictionary.json');
const VOCAB_IMPORT_FILE = path.join(DATA_DIR, 'vocabulary-imports.json');
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
let dictionaryStore = readStore(DICTIONARY_FILE);
function saveMail() { saveStore(MAIL_FILE, mailStore); }
function saveChat() { saveStore(CHAT_FILE, chatStore); }
function saveDictionary() { saveStore(DICTIONARY_FILE, dictionaryStore); }

// 끝말왕 프로젝트 파일에 포함된 기본 단어와 특수 어휘를 최초 실행 때 가져옵니다.
// 뜻이 없는 단어도 검색되며, 유저가 오픈사전에 뜻을 추가할 수 있습니다.
try {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-words.json'), 'utf8'));
  const words = Array.isArray(seed.words) ? seed.words : [];
  let changed = false;
  for (const rawWord of words) {
    const word = String(rawWord || '').trim();
    if (!word) continue;
    if (dictionaryStore.some(entry => entry.type === 'official' && entry.word === word && entry.source === '끝말왕')) continue;
    dictionaryStore.push({
      id: crypto.randomBytes(12).toString('hex'),
      word, definition: '', pos: '', example: '',
      type: 'official', author: 'dictionary-import',
      authorName: '끝말왕 기존 단어장', source: '끝말왕',
      createdAt: '2026-10-12T00:00:00.000Z'
    });
    changed = true;
  }
  if (changed) saveDictionary();
} catch (e) {
  console.error('끝말왕 기본 단어 목록을 읽지 못했어요:', e.message);
}

// 대규모 단어장은 개별 사전 항목으로 복제하지 않고 텍스트로 읽어 검색에 사용합니다.
const BULK_VOCABULARY_DIR = path.join(__dirname, 'vocabulary');
let bulkVocabularyWords = [];
try {
  const files = fs.readdirSync(BULK_VOCABULARY_DIR)
    .filter(name => /^words-\\d{2}\\.txt$/.test(name))
    .sort();
  for (const file of files) {
    const content = fs.readFileSync(path.join(BULK_VOCABULARY_DIR, file), 'utf8');
    for (const raw of content.split(/\\r?\\n/)) {
      const word = raw.trim().normalize('NFC');
      if (/^[가-힣]{1,50}$/.test(word)) bulkVocabularyWords.push(word);
    }
  }
  console.log('끝말왕 대규모 단어장 로드 완료: ' + bulkVocabularyWords.length.toLocaleString('ko-KR') + '개');
} catch (e) {
  console.error('끝말왕 대규모 단어장을 읽지 못했어요:', e.message);
}

// 끝말왕에서 사용하던 공개 단어 목록을 백그라운드로 가져옵니다.
// 외부 목록이 잠시 실패해도 내장 단어장과 사전 서비스는 계속 작동합니다.
const GAME_WORD_SOURCES = [
  {
    name: '끝말왕 한국어 명사 목록',
    url: 'https://gist.githubusercontent.com/A-H4NU/bb4fa141d2b89b1892f747ef923e3044/raw/2bf2ea339ac725910bee8d6fc0469a907105f514/beginner_korean_nouns.txt'
  },
  {
    name: '끝말왕 고빈도 어휘 목록',
    url: 'https://raw.githubusercontent.com/oprogramador/most-common-words-by-language/master/src/resources/korean.txt'
  },
  {
    name: '끝말왕 확장 단어 목록',
    url: 'https://raw.githubusercontent.com/acidsound/korean_wordlist/master/wordslistUnique.txt'
  }
];
let vocabularyImportStatus = { state: '대기 중', importedWords: 0, sources: [] };
let vocabularyImportState = {};
try {
  const saved = JSON.parse(fs.readFileSync(VOCAB_IMPORT_FILE, 'utf8'));
  if (saved && typeof saved === 'object') vocabularyImportState = saved;
} catch { /* 최초 실행 */ }

async function importGameVocabulary() {
  if (vocabularyImportStatus.state === '가져오는 중') return;
  vocabularyImportStatus.state = '가져오는 중';
  const now = Date.now();
  const knownGameWords = new Set(
    dictionaryStore
      .filter(entry => entry.type === 'official' && String(entry.source || '').startsWith('끝말왕'))
      .map(entry => String(entry.word || '').normalize('NFC'))
  );
  const skipWords = new Set(['그리고','하지만','그럼','정말','너무','어서','그래서','어떻게','무슨','이렇게','저렇게','그렇게']);
  const results = [];
  let totalAdded = 0;
  for (const source of GAME_WORD_SOURCES) {
    const previous = vocabularyImportState[source.url];
    const sourceStillPresent = dictionaryStore.some(entry =>
      entry.type === 'official' && entry.source === source.name
    );
    if (previous && previous.importedAt && now - Date.parse(previous.importedAt) < 30 * 864e5 && sourceStillPresent) {
      totalAdded += Number(previous.added || 0);
      results.push({ name: source.name, state: '이미 가져옴', added: Number(previous.added || 0) });
      continue;
    }
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(source.url, { signal: controller.signal, headers: { 'User-Agent': 'YeoleDictionary/1.0' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);

      // 무료 호스팅 메모리 보호: 외부 목록은 소스마다 최대 1.5MB만 읽습니다.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let bytesRead = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const remaining = 1.5 * 1024 * 1024 - bytesRead;
        if (value.byteLength > remaining) {
          if (remaining > 0) text += decoder.decode(value.slice(0, remaining), { stream: true });
          await reader.cancel();
          break;
        }
        bytesRead += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const addedEntries = [];
      for (const raw of text.split(/\r?\n|[,;\t]/)) {
        if (addedEntries.length >= 5000) break;
        const word = String(raw || '').replace(/^\s*[|]\s*/, '').replace(/^\s*[0-9]+[.)]\s*/, '').trim().normalize('NFC');
        if (!/^[가-힣]{2,50}$/.test(word) || skipWords.has(word) || knownGameWords.has(word)) continue;
        knownGameWords.add(word);
        addedEntries.push({
          id: crypto.randomBytes(12).toString('hex'),
          word, definition: '', pos: '', example: '',
          type: 'official', author: 'dictionary-import',
          authorName: '끝말왕 단어장', source: source.name,
          createdAt: new Date().toISOString()
        });
      }
      if (addedEntries.length) {
        dictionaryStore = dictionaryStore.concat(addedEntries);
        saveDictionary();
      }
      totalAdded += addedEntries.length;
      vocabularyImportState[source.url] = { importedAt: new Date().toISOString(), added: addedEntries.length };
      saveStore(VOCAB_IMPORT_FILE, vocabularyImportState);
      results.push({ name: source.name, state: '완료', added: addedEntries.length });
    } catch (error) {
      results.push({ name: source.name, state: '실패 — 기본 단어장은 사용 가능', added: 0 });
      console.warn('끝말왕 단어 목록을 가져오지 못했어요:', source.name, error.message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  vocabularyImportStatus = {
    state: results.every(item => item.state === '완료' || item.state === '이미 가져옴') ? '완료' : '일부 목록 사용 불가',
    importedWords: totalAdded,
    sources: results
  };
  console.log('끝말왕 단어 목록 가져오기:', JSON.stringify(vocabularyImportStatus));
}

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
const isHttps = (req) => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
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

  /* 사전 검색은 공개합니다. 큰 단어장도 빠르게 열리도록 페이지 단위로 반환합니다. */
  if (pathname === '/api/dictionary/status' && method === 'GET') {
    return send(res, 200, {
      status: vocabularyImportStatus.state,
      importedWords: vocabularyImportStatus.importedWords,
      sources: vocabularyImportStatus.sources
    });
  }

  if (pathname === '/api/dictionary' && method === 'GET') {
    const q = String(query.get('q') || '').trim().normalize('NFC').toLocaleLowerCase('ko-KR').slice(0, 100);
    const type = ['official', 'open'].includes(query.get('type')) ? query.get('type') : 'all';
    const page = Math.max(0, Math.min(100000, Number.parseInt(query.get('page') || '0', 10) || 0));
    const limit = Math.max(10, Math.min(100, Number.parseInt(query.get('limit') || '40', 10) || 40));
    const hasWildcard = /[*?]/.test(q);
    // *는 0개 이상의 글자, ?는 정확히 한 글자입니다.
    function wildcardMatches(word, pattern) {
      const target = String(word || '').normalize('NFC').toLocaleLowerCase('ko-KR');
      let ti = 0, pi = 0, lastStar = -1, retryAt = 0;
      while (ti < target.length) {
        if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === target[ti])) {
          ti++;
          pi++;
          continue;
        }
        if (pi < pattern.length && pattern[pi] === '*') {
          lastStar = pi++;
          retryAt = ti;
          continue;
        }
        if (lastStar !== -1) {
          pi = lastStar + 1;
          ti = ++retryAt;
          continue;
        }
        return false;
      }
      while (pi < pattern.length && pattern[pi] === '*') pi++;
      return pi === pattern.length;
    }
    const matches = dictionaryStore.filter(entry => {
      if (type !== 'all' && entry.type !== type) return false;
      if (!q) return true;
      const word = String(entry.word || '').normalize('NFC').toLocaleLowerCase('ko-KR');
      if (hasWildcard) return wildcardMatches(word, q);
      return [entry.word, entry.definition, entry.pos, entry.example, entry.authorName]
        .some(value => String(value || '').normalize('NFC').toLocaleLowerCase('ko-KR').includes(q));
    });
    const rank = entry => (String(entry.definition || '').trim() ? 0 : 10) + (entry.type === 'official' ? 0 : 1);
    matches.sort((a, b) => rank(a) - rank(b) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.word).localeCompare(String(b.word), 'ko'));
    const start = page * limit;
    const entries = start < matches.length ? matches.slice(start, start + limit) : [];
    const bulkOffset = Math.max(0, start - matches.length);
    let bulkTotal = 0;
    if (type !== 'open' && bulkVocabularyWords.length) {
      const knownWords = new Set(dictionaryStore
        .filter(entry => type === 'all' || entry.type === type)
        .map(entry => String(entry.word || '').normalize('NFC').toLocaleLowerCase('ko-KR')));
      for (const word of bulkVocabularyWords) {
        if (knownWords.has(word)) continue;
        if (q && (hasWildcard ? !wildcardMatches(word, q) : !word.includes(q))) continue;
        if (bulkTotal >= bulkOffset && entries.length < limit) {
          entries.push({
            id: 'bulk-' + word,
            word,
            definition: '',
            pos: '',
            example: '',
            type: 'official',
            author: 'dictionary-import',
            authorName: '끝말왕 단어장',
            source: '끝말왕 대규모 단어장',
            createdAt: ''
          });
        }
        bulkTotal++;
      }
    }
    const total = matches.length + bulkTotal;
    return send(res, 200, {
      entries,
      page, limit, total, hasMore: start + limit < total
    });
  }

  if (!me) return send(res, 401, { error: '로그인이 필요해요.' });

  if (pathname === '/api/admin/dictionary/import-game-words' && method === 'POST') {
    if (me.role !== 'admin') return send(res, 403, { error: '관리자만 단어장을 동기화할 수 있어요.' });
    if (vocabularyImportStatus.state === '가져오는 중') return send(res, 409, { error: '이미 단어장을 가져오고 있어요.' });
    console.log('관리자 요청으로 끝말왕 단어장 동기화를 시작합니다.');
    importGameVocabulary().catch(error => {
      console.error('끝말왕 단어장 동기화 오류:', error);
      vocabularyImportStatus = { state: '일부 목록 사용 불가', importedWords: 0, sources: [] };
    });
    return send(res, 202, { ok: true, message: '끝말왕 단어장 동기화를 시작했어요.' });
  }

  /* ---------- yeole 국어사전: 로그인한 유저의 등록·관리 ---------- */
  if (pathname === '/api/dictionary' && method === 'POST') {
    const b = await readJson(req);
    const word = String(b.word || '').trim().normalize('NFC').replace(/\s+/g, ' ').slice(0, 60);
    const definition = String(b.definition || '').trim().slice(0, 1200);
    const pos = String(b.pos || '').trim().slice(0, 30);
    const example = String(b.example || '').trim().slice(0, 500);
    if (!word || !definition) return send(res, 400, { error: '단어와 뜻을 입력하세요.' });
    if (/[\u0000-\u001f\u007f]/.test(word)) return send(res, 400, { error: '단어에 사용할 수 없는 문자가 있어요.' });
    const duplicate = dictionaryStore.some(entry => String(entry.word || '').normalize('NFC').toLocaleLowerCase('ko-KR') === word.toLocaleLowerCase('ko-KR') && String(entry.definition || '').trim().normalize('NFC').toLocaleLowerCase('ko-KR') === definition.normalize('NFC').toLocaleLowerCase('ko-KR'));
    if (duplicate) return send(res, 409, { error: '같은 단어와 뜻이 이미 등록되어 있어요.' });
    if (limited('dictionary|' + me.username)) return send(res, 429, { error: '단어 등록을 너무 자주 하고 있어요. 잠시 후 다시 시도하세요.' });
    hit('dictionary|' + me.username, 8, 60e3);
    const entry = {
      id: crypto.randomBytes(12).toString('hex'),
      word, definition, pos, example,
      type: me.role === 'admin' ? 'official' : 'open',
      author: me.username,
      authorName: me.name,
      createdAt: new Date().toISOString()
    };
    dictionaryStore.push(entry);
    saveDictionary();
    return send(res, 201, { entry });
  }

  if (pathname.startsWith('/api/dictionary/') && method === 'DELETE') {
    const id = pathname.slice('/api/dictionary/'.length);
    if (!/^[a-f0-9]{24}$/.test(id)) return send(res, 400, { error: '잘못된 단어 항목이에요.' });
    const entry = dictionaryStore.find(x => x.id === id);
    if (!entry) return send(res, 404, { error: '단어 항목을 찾을 수 없어요.' });
    if (me.role !== 'admin' && entry.author !== me.username) return send(res, 403, { error: '작성자 또는 관리자만 삭제할 수 있어요.' });
    dictionaryStore = dictionaryStore.filter(x => x.id !== entry.id);
    saveDictionary();
    return send(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/admin/dictionary/') && pathname.endsWith('/official') && method === 'POST') {
    if (me.role !== 'admin') return send(res, 403, { error: '관리자만 공식 단어로 지정할 수 있어요.' });
    const id = pathname.slice('/api/admin/dictionary/'.length, -'/official'.length);
    if (!/^[a-f0-9]{24}$/.test(id)) return send(res, 400, { error: '잘못된 단어 항목이에요.' });
    const entry = dictionaryStore.find(x => x.id === id);
    if (!entry) return send(res, 404, { error: '단어 항목을 찾을 수 없어요.' });
    entry.type = 'official';
    entry.reviewedAt = new Date().toISOString();
    entry.reviewedBy = me.username;
    saveDictionary();
    return send(res, 200, { entry });
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
// Render 프록시의 keep-alive 연결 재사용으로 인한 간헐적 502를 줄입니다.
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;
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

/* ---------- 서버 먼저 실행 + 관리자 초기화 ---------- */
// Render 등 호스팅 환경에서는 반드시 외부 인터페이스(0.0.0.0)에 바인딩합니다.
// 관리자 계정 초기화가 실패하더라도 웹 서버 자체는 먼저 실행되게 합니다.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ymail 실행 중 → 포트 ${PORT}`);
  console.log(pickProvider() ? `검색 서비스: ${pickProvider()}` : '참고: 검색 서비스(TAVILY_API_KEY 등)가 설정되지 않아 검색은 아직 동작하지 않아요.');
  // 외부 단어장 가져오기는 메모리 사용량을 줄이기 위해 시작할 때 자동 실행하지 않습니다. 관리자 메뉴에서 필요할 때 실행할 수 있습니다.
});

(async () => {
  try {
    const an = normUsername(process.env.ADMIN_USERNAME), ap = process.env.ADMIN_PASSWORD;
    if (!an || !ap) {
      console.log('관리자 환경변수(ADMIN_USERNAME / ADMIN_PASSWORD)가 설정되지 않았습니다.');
      return;
    }
    const existing = findUser(an);
    if (!existing) {
      const { salt, hash } = await hashPassword(ap);
      users.push({ username: an, name: String(process.env.ADMIN_DISPLAY_NAME || '관리자').trim().slice(0, 40), salt, hash, role: 'admin', createdAt: new Date().toISOString() });
      saveUsers();
      console.log('관리자 계정을 만들었어요: ' + an + '@' + DOMAIN);
    } else if (existing.role !== 'admin' && await checkPassword(ap, existing)) {
      existing.role = 'admin';
      saveUsers();
      console.log('기존 계정을 관리자 권한으로 설정했어요: ' + an + '@' + DOMAIN);
    }
  } catch (error) {
    console.error('관리자 계정 초기화 오류 (웹 서버는 계속 실행됩니다):', error);
  }
})();
