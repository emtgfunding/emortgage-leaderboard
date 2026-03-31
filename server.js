const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const SF_URL           = process.env.SF_URL            || 'https://emtg.my.salesforce.com';
const SF_CLIENT_ID     = process.env.SF_CLIENT_ID      || '';
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET  || '';
const VICI_BASE        = process.env.VICI_BASE          || 'http://emortgage.talkitpro.com';
const VICI_USER        = process.env.VICI_USER          || '';
const VICI_PASS        = process.env.VICI_PASS          || '';

app.use(express.json());

// Allow SF iframe embedding
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "frame-ancestors 'self' https://*.salesforce.com https://*.force.com https://*.lightning.force.com https://*.visualforce.com");
  next();
});

// Serve frontend from root directory
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Salesforce token cache (reuse for 55min) ──────────────────────────────────
let sfCache = { token: null, instance: null, expires: 0 };

async function getSFToken() {
  if (sfCache.token && Date.now() < sfCache.expires) return sfCache;
  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });
  const r = await fetch(`${SF_URL}/services/oauth2/token`, {
    method: 'POST',
    body:   params,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('SF auth failed: ' + JSON.stringify(d));
  sfCache = {
    token:    d.access_token,
    instance: d.instance_url || SF_URL,
    expires:  Date.now() + 55 * 60 * 1000,
  };
  return sfCache;
}

// ── VICIdial session cache (reuse for 4hrs) ───────────────────────────────────
let viciCookie = { value: null, expires: 0 };

async function getViciCookie() {
  if (viciCookie.value && Date.now() < viciCookie.expires) return viciCookie.value;
  const body = new URLSearchParams({ user: VICI_USER, pass: VICI_PASS, ACTION: 'Login' });

  // Try redirect: manual first (captures Set-Cookie on redirect response)
  let cookie = '';
  try {
    const r = await fetch(`${VICI_BASE}/vicidial/admin.php`, {
      method: 'POST', body, redirect: 'manual',
    });
    const raw = r.headers.raw()['set-cookie'] || [];
    cookie = raw.map(c => c.split(';')[0]).join('; ');
  } catch(e) {}

  // Fallback: follow redirects and grab cookie from response headers
  if (!cookie) {
    const r = await fetch(`${VICI_BASE}/vicidial/admin.php`, {
      method: 'POST', body, redirect: 'follow',
    });
    const raw = r.headers.raw()['set-cookie'] || [];
    cookie = raw.map(c => c.split(';')[0]).join('; ');
  }

  // Fallback: try GET login
  if (!cookie) {
    const r = await fetch(`${VICI_BASE}/vicidial/admin.php?user=${VICI_USER}&pass=${VICI_PASS}&ACTION=Login`, {
      redirect: 'manual',
    });
    const raw = r.headers.raw()['set-cookie'] || [];
    cookie = raw.map(c => c.split(';')[0]).join('; ');
  }

  if (!cookie) throw new Error('VICIdial login failed');
  viciCookie = { value: cookie, expires: Date.now() + 4 * 60 * 60 * 1000 };
  return cookie;
}

// ── /api/sf — SOQL proxy ──────────────────────────────────────────────────────
app.get('/api/sf', async (req, res) => {
  try {
    const { token, instance } = await getSFToken();
    const soql = req.query.q;
    if (!soql) return res.status(400).json({ error: 'Missing query param q' });

    const url = `${instance}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (d.errorCode) throw new Error(d.message || JSON.stringify(d));
    res.json(d.records || []);
  } catch (e) {
    console.error('SF error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── OPTIONS preflight for vici-push ──────────────────────────────────────────
app.options('/api/vici-push', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

// ── In-memory dialer cache (populated by bookmarklet push) ───────────────────
let dialerCache = { agents: [], date: null, updatedAt: null };

// ── /api/vici-push — bookmarklet POSTs agent data here ───────────────────────
app.post('/api/vici-push', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const { agents, date } = req.body;
  if (!Array.isArray(agents) || !agents.length) {
    return res.status(400).json({ error: 'No agents in payload' });
  }
  dialerCache = { agents, date: date || new Date().toISOString().split('T')[0], updatedAt: new Date().toISOString() };
  console.log(`[VICIdial] Push: ${agents.length} agents for ${dialerCache.date}`);
  res.json({ ok: true, agents: agents.length, date: dialerCache.date });
});

// ── /api/vici — serve cached data OR fetch report directly ───────────────────
app.get('/api/vici', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  // Return cached data if fresh for today
  if (dialerCache.agents.length > 0 && dialerCache.date === date) {
    return res.json(dialerCache.agents);
  }

  // Try fetching the report directly — VICIdial accepts user/pass in POST body
  try {
    const body = new URLSearchParams({
      DB: '0',
      query_date: date, query_time: '00:00:00',
      end_date: date,   end_time: '23:59:59',
      'group[]': '--ALL--', 'user_group[]': '--ALL--', 'users[]': '--ALL--',
      report_display_type: 'TEXT', shift: '--', SUBMIT: 'SUBMIT',
      // Try passing credentials directly in the report request
      user: VICI_USER, pass: VICI_PASS,
    });
    const r = await fetch(`${VICI_BASE}/vicidial/AST_agent_performance_detail.php`, {
      method: 'POST', body,
    });
    const html = await r.text();
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (preMatch) {
      const agents = [];
      for (const line of preMatch[1].split('\n')) {
        if (!line.startsWith('|')) continue;
        const cols = line.split('|').map(c => c.trim());
        if (cols.length < 7) continue;
        const calls = parseInt(cols[5]);
        if (!cols[1] || cols[1] === 'USER NAME' || isNaN(calls)) continue;
        agents.push({ name: cols[1], id: cols[2], group: cols[3], dials: calls });
      }
      if (agents.length > 0) {
        dialerCache = { agents, date, updatedAt: new Date().toISOString() };
        return res.json(agents);
      }
    }
    throw new Error('No agents in report response');
  } catch(e) {
    console.error('VICIdial direct fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/vici-proxy — browser passes its own VICIdial session cookie ─────────
// Browser calls this with header X-Vici-Cookie containing its own session cookie
// Server forwards the request to VICIdial using that cookie — bypasses login entirely
app.get('/api/vici-proxy', async (req, res) => {
  try {
    const viciCookieHeader = req.headers['x-vici-cookie'];
    if (!viciCookieHeader) return res.status(400).json({ error: 'No X-Vici-Cookie header' });
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const url = `${VICI_BASE}/vicidial/AST_agent_performance_detail.php?` + new URLSearchParams({
      DB: '0', query_date: date, query_time: '00:00:00',
      end_date: date, end_time: '23:59:59',
      'group[]': '--ALL--', 'user_group[]': '--ALL--', 'users[]': '--ALL--',
      report_display_type: 'TEXT', shift: '--', SUBMIT: 'SUBMIT',
    });
    const r = await fetch(url, { headers: { Cookie: viciCookieHeader } });
    const html = await r.text();
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    const text = preMatch ? preMatch[1] : html;
    const agents = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cols = line.split('|').map(c => c.trim());
      if (cols.length < 7) continue;
      const name = cols[1], id = cols[2], group = cols[3];
      const calls = parseInt(cols[5]);
      if (!name || name === 'USER NAME' || isNaN(calls)) continue;
      agents.push({ name, id, group, dials: calls });
    }
    if (agents.length === 0) return res.status(401).json({ error: 'No agents — cookie may be expired or invalid' });
    res.json(agents);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/vici-debug', async (req, res) => {
  try {
    const body = new URLSearchParams({ user: VICI_USER, pass: VICI_PASS, ACTION: 'Login' });
    const r = await fetch(`${VICI_BASE}/vicidial/admin.php`, {
      method: 'POST', body, redirect: 'manual',
    });
    const raw = r.headers.raw();
    const status = r.status;
    const location = r.headers.get('location');
    const cookies = raw['set-cookie'] || [];
    const bodyText = await r.text().catch(() => '');
    res.json({ status, location, cookies, bodySnippet: bodyText.substring(0, 500) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/status', (req, res) => {
  res.json({
    sf_configured:      !!(SF_CLIENT_ID),
    vici_configured:    !!(VICI_USER && VICI_BASE),
    sf_token_cached:    !!(sfCache.token && Date.now() < sfCache.expires),
    vici_cookie_cached: !!(viciCookie.value && Date.now() < viciCookie.expires),
  });
});

app.listen(PORT, () => console.log(`Leaderboard running on port ${PORT}`));