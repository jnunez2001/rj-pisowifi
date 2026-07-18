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

// Summary + top blocked domains in one call for the admin panel's card.
// Returns { available: false } if the service is off, unreachable, or the
// stored credential is missing/stale - the panel shows "not available"
// rather than an error in that case.
async function getStatus() {
  try {
    const sid = await login();
    if (!sid) return { available: false };

    const headers = { sid };
    const [summaryRes, topRes] = await Promise.all([
      fetchWithTimeout(`${BASE_URL}/stats/summary`, { headers }),
      fetchWithTimeout(`${BASE_URL}/stats/top_domains?blocked=true&count=5`, { headers })
    ]);

    if (!summaryRes.ok) return { available: false };
    const summary = await summaryRes.json();
    const top = topRes.ok ? await topRes.json() : { domains: [] };

    const queries = summary?.queries?.total ?? 0;
    const blocked = summary?.queries?.blocked ?? 0;
    const percent = summary?.queries?.percent_blocked ?? (queries > 0 ? Math.round((blocked / queries) * 1000) / 10 : 0);

    return {
      available: true,
      queries_today: queries,
      blocked_today: blocked,
      blocked_percent: percent,
      top_blocked: (top?.domains || []).map((d) => ({ domain: d.domain, count: d.count }))
    };
  } catch (e) {
    return { available: false };
  }
}

module.exports = { getStatus };
