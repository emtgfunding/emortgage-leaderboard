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
  const r = await fetch(`${VICI_BASE}/vicidial/admin.php`, {
    method: 'POST', body, redirect: 'manual',
  });
  const raw = r.headers.raw()['set-cookie'] || [];
  const cookie = raw.map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('VICIdial login failed');
  viciCookie = { value: cookie, expires: Date.now() + 4 * 60 * 60 * 1000 };
  return cookie;
}

// ── /api/sf — SOQL proxy with profile filter ──────────────────────────────────
app.get('/api/sf', async (req, res) => {
  try {
    const { token, instance } = await getSFToken();
    let soql = req.query.q;
    if (!soql) return res.status(400).json({ error: 'Missing query param q' });

    // Only include users with Loan Officer or LOA profiles
    const profileFilter = `OwnerId IN (SELECT Id FROM User WHERE Profile.Name IN ('Loan Officer Profile', 'LOA') AND IsActive = true)`;

    if (soql.includes('FROM Lead') && soql.toUpperCase().includes('WHERE')) {
      soql = soql.replace(/FROM Lead WHERE/i, `FROM Lead WHERE ${profileFilter} AND`);
    }
    if (soql.includes('FROM Opportunity') && soql.toUpperCase().includes('WHERE')) {
      soql = soql.replace(/FROM Opportunity WHERE/i, `FROM Opportunity WHERE ${profileFilter} AND`);
    }

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

// ── /api/vici — VICIdial report proxy ────────────────────────────────────────
app.get('/api/vici', async (req, res) => {
  try {
    const cookie = await getViciCookie();
    const date   = req.query.date || new Date().toISOString().split('T')[0];
    const url = `${VICI_BASE}/vicidial/AST_agent_performance_detail.php?` + new URLSearchParams({
      DB: '0',
      query_date: date, query_time: '00:00:00',
      end_date:   date, end_time:   '23:59:59',
      'group[]':       '--ALL--',
      'user_group[]':  '--ALL--',
      'users[]':       '--ALL--',
      report_display_type: 'TEXT',
      shift: '--',
      SUBMIT: 'SUBMIT',
    });
    const r = await fetch(url, { headers: { Cookie: cookie } });
    const html = await r.text();
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    const text = preMatch ? preMatch[1] : html;
    const agents = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cols = line.split('|').map(c => c.trim());
      if (cols.length < 7) continue;
      const name  = cols[1];
      const id    = cols[2];
      const group = cols[3];
      const calls = parseInt(cols[5]);
      if (!name || name === 'USER NAME' || isNaN(calls)) continue;
      agents.push({ name, id, group, dials: calls });
    }
    res.json(agents);
  } catch (e) {
    console.error('VICIdial error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/status ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    sf_configured:      !!(SF_CLIENT_ID),
    vici_configured:    !!(VICI_USER && VICI_BASE),
    sf_token_cached:    !!(sfCache.token && Date.now() < sfCache.expires),
    vici_cookie_cached: !!(viciCookie.value && Date.now() < viciCookie.expires),
  });
});

app.listen(PORT, () => console.log(`Leaderboard running on port ${PORT}`));