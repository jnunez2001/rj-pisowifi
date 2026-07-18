// Talks to the local ad/tracker-blocking DNS service (runs as an isolated
// loopback-only container, see setup/install-pihole.sh). Kept as its own
// service module so the admin routes stay thin and this is the one place
// that knows the upstream's actual API shape.
//
// Every function here fails soft (returns { available: false }, never
// throws) - matches this app's fail-open rule for add-ons. A customer's
// DNS keeps working via the public-DNS fallback in setup-network.sh
// regardless of what happens here; this module only feeds the admin
// panel's stats card, so a failure here should never be treated as urgent.
const db = require('../config/database');
const { decryptSecret } = require('../utils/secretCrypto');

const BASE_URL = 'http://127.0.0.1:8081/api';
const TIMEOUT_MS = 4000;

function getStoredPassword() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'pihole_api_pass'").get();
  return row && row.value ? decryptSecret(row.value) : '';
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  const password = getStoredPassword();
  if (!password) return null;
  const res = await fetchWithTimeout(`${BASE_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.session?.sid || null;
}

// Pulls a number out of a response body trying several plausible field
// paths - never verified against a live instance before shipping (no
// Pi-hole available in this dev environment), and different Pi-hole FTL
// versions have shuffled the summary schema before (v5 vs v6 alone differ:
// flat dns_queries_today/ads_blocked_today vs nested queries.total/
// queries.blocked). Reported live as "always 0" even with real traffic
// flowing through the container, so single-path field access was almost
// certainly the bug - this tries the v6 nested shape first, then v5's flat
// shape, before giving up and logging the actual raw body so the real
// shape can be read directly from the server logs if it's still wrong.
function pick(obj, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// Summary + top blocked domains in one call for the admin panel's card.
// Returns { available: false } if the service is off, unreachable, or the
// stored credential is missing/stale - the panel shows "not available"
// rather than an error in that case.
async function getStatus() {
  try {
    const sid = await login();
    if (!sid) {
      console.warn('[DNS Filter] Could not authenticate - check the stored credential (re-run install-pihole.sh to regenerate it)');
      return { available: false };
    }

    const headers = { sid };
    const [summaryRes, topRes] = await Promise.all([
      fetchWithTimeout(`${BASE_URL}/stats/summary`, { headers }),
      fetchWithTimeout(`${BASE_URL}/stats/top_domains?blocked=true&count=5`, { headers })
    ]);

    if (!summaryRes.ok) {
      console.warn(`[DNS Filter] /stats/summary returned HTTP ${summaryRes.status}`);
      return { available: false };
    }
    const summary = await summaryRes.json();
    const top = topRes.ok ? await topRes.json() : { domains: [] };

    const queries = pick(summary, ['queries.total', 'dns_queries_today', 'queries_today']) ?? 0;
    const blocked = pick(summary, ['queries.blocked', 'ads_blocked_today', 'blocked_today']) ?? 0;
    const percent = pick(summary, ['queries.percent_blocked', 'ads_percentage_today'])
      ?? (queries > 0 ? Math.round((blocked / queries) * 1000) / 10 : 0);

    if (queries === 0) {
      // Not necessarily a bug (a fresh container with no traffic yet is
      // genuinely 0) - but logged so a real parsing failure is visible
      // instead of silently looking identical to "no traffic yet".
      console.log('[DNS Filter] Summary shows 0 queries - raw response for debugging:', JSON.stringify(summary).slice(0, 500));
    }

    const domainsList = top?.domains || top?.top_domains || [];
    return {
      available: true,
      queries_today: queries,
      blocked_today: blocked,
      blocked_percent: percent,
      top_blocked: domainsList.map((d) => ({ domain: d.domain || d.name, count: d.count }))
    };
  } catch (e) {
    console.error('[DNS Filter] getStatus() failed:', e.message);
    return { available: false };
  }
}

module.exports = { getStatus };
