const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
// public ada di ../public dari folder api/
app.use(express.static(path.join(__dirname, '..', 'public')));

/*const API_KEY_PTRO = process.env.API_KEY_PTRO || '';
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || '';
const DOMAIN_PANEL = (process.env.DOMAIN_PANEL || '').replace(/\/$/, '');
const CONFIG_LOC_ID = Number(process.env.CONFIG_LOC_ID || 1);
const CONFIG_EGG_ID = Number(process.env.CONFIG_EGG_ID || 15);*/
const API_KEY_PTRO = 'ptla_fPwRd8QppEw7KyVWXUp8SA9xCN5mH6uahbprTDi8xqY';
const CLIENT_API_KEY = 'ptlc_5gzvolQXzzkLK7tMEs92X7Oa4XSr1nRQzZ59PkT6MQZ';
const DOMAIN_PANEL = 'https://panel.kyx.my.id';
const CONFIG_LOC_ID = 1;
const CONFIG_EGG_ID = 15;

console.log('[BOOT] DOMAIN=', DOMAIN_PANEL, 'has_ptla=', !!API_KEY_PTRO, 'ptla_len=', API_KEY_PTRO.length, 'has_ptlc=', !!CLIENT_API_KEY, 'ptlc_len=', CLIENT_API_KEY.length);

const appHeaders = {
  'Authorization': `Bearer ${API_KEY_PTRO}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};
const clientHeaders = {
  'Authorization': `Bearer ${CLIENT_API_KEY}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

async function fetchJson(url, headers, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, ...options });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.errors?.[0]?.detail || data?.message || text || `HTTP ${res.status}`;
      const err = new Error(`[${res.status}] ${msg} | URL: ${url}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout 15s ke ${url} - panel lemot / tidak bisa dijangkau dari Vercel`);
    // fetch failed murni (DNS / SSL / panel down)
    if (e.cause) console.error('[FETCH CAUSE]', e.cause);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllApplication(pathname, extra = '') {
  let page = 1;
  let all = [];
  let totalPages = 1;
  do {
    const sep = pathname.includes('?') ? '&' : '?';
    const url = `${DOMAIN_PANEL}${pathname}${sep}per_page=100&page=${page}${extra}`;
    const json = await fetchJson(url, appHeaders);
    all = all.concat(json.data || []);
    totalPages = json.meta?.pagination?.total_pages || 1;
    page++;
  } while (page <= totalPages);
  return all;
}
async function getAllServersApp() {
  return fetchAllApplication('/api/application/servers', '&include=user,node,egg,allocations,location');
}
async function getAllUsersApp() {
  return fetchAllApplication('/api/application/users');
}
async function getServerStatus(identifier) {
  try {
    const json = await fetchJson(`${DOMAIN_PANEL}/api/client/servers/${identifier}/resources`, clientHeaders);
    return json.attributes?.current_state || 'unknown';
  } catch (e) {
    console.error('[STATUS FAIL]', identifier, e.message);
    return 'unknown';
  }
}
async function attachStatus(servers) {
  const results = [];
  const chunkSize = 5;
  for (let i = 0; i < servers.length; i += chunkSize) {
    const chunk = servers.slice(i, i + chunkSize);
    const withStatus = await Promise.all(chunk.map(async (s) => {
      const a = s.attributes || {};
      const status = await getServerStatus(a.identifier);
      return {
        no: 0, id: a.id, uuid: a.uuid, identifier: a.identifier, name: a.name,
        description: a.description || '', node_id: a.node,
        node_name: a.relationships?.node?.attributes?.name || `Node ${a.node}`,
        egg_id: a.egg, egg_name: a.relationships?.egg?.attributes?.name || `Egg ${a.egg}`,
        user_id: a.user, user_email: a.relationships?.user?.attributes?.email || '',
        user_name: a.relationships?.user?.attributes?.username || '',
        limits: a.limits || {}, feature_limits: a.feature_limits || {},
        allocation: a.allocation,
        allocations: (a.relationships?.allocations?.data || []).map(x => x.attributes),
        status, is_suspended: !!a.is_suspended, created_at: a.created_at, updated_at: a.updated_at,
      };
    }));
    results.push(...withStatus);
  }
  results.sort((x, y) => x.id - y.id);
  results.forEach((r, idx) => r.no = idx + 1);
  return results;
}

// HEALTH - ini yang dibuka dulu buat debug
app.get('/api/health', async (req, res) => {
  const baseInfo = {
    ok: true, domain: DOMAIN_PANEL, loc_id: CONFIG_LOC_ID, egg_id: CONFIG_EGG_ID,
    has_ptla: !!API_KEY_PTRO, ptla_len: API_KEY_PTRO.length,
    has_ptlc: !!CLIENT_API_KEY, ptlc_len: CLIENT_API_KEY.length,
  };
  // coba ping panel beneran
  try {
    if (!DOMAIN_PANEL) throw new Error('DOMAIN_PANEL kosong di Env');
    if (!API_KEY_PTRO) throw new Error('API_KEY_PTRO kosong di Env');
    const test = await fetchJson(`${DOMAIN_PANEL}/api/application/servers?per_page=1&page=1`, appHeaders);
    return res.json({ ...baseInfo, panel_reachable: true, panel_test_count: test.data?.length ?? 0, panel_pagination: test.meta?.pagination || null });
  } catch (e) {
    return res.json({ ...baseInfo, panel_reachable: false, panel_error: e.message });
  }
});

app.get('/api/servers', async (req, res) => {
  try {
    const raw = await getAllServersApp();
    const withStatus = await attachStatus(raw);
    const counts = {
      total: withStatus.length,
      online: withStatus.filter(s => s.status === 'running').length,
      offline: withStatus.filter(s => ['offline', 'stopped'].includes(s.status)).length,
      unknown: withStatus.filter(s => !['running', 'offline', 'stopped'].includes(s.status)).length,
    };
    res.json({ success: true, counts, servers: withStatus });
  } catch (e) {
    console.error('[GET /api/servers]', e);
    res.status(500).json({ success: false, message: e.message, hint: 'Cek /api/health untuk detail panel_error' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const [usersRaw, serversRaw] = await Promise.all([getAllUsersApp(), getAllServersApp()]);
    const userIdsWithServer = new Set(serversRaw.map(s => s.attributes.user));
    const users = usersRaw.map(u => {
      const a = u.attributes;
      return { id: a.id, uuid: a.uuid, username: a.username, email: a.email, first_name: a.first_name, last_name: a.last_name, admin: a.root_admin, has_server: userIdsWithServer.has(a.id), created_at: a.created_at };
    }).sort((a, b) => a.id - b.id);
    res.json({ success: true, counts: { total: users.length, with_server: users.filter(u => u.has_server).length, without_server: users.filter(u => !u.has_server).length }, users });
  } catch (e) {
    console.error('[GET /api/users]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.delete('/api/servers/one', async (req, res) => {
  try {
    const targetRaw = String(req.body?.target ?? req.query?.target ?? '').trim();
    if (!targetRaw) return res.status(400).json({ success: false, message: 'Isi No / ID server dulu' });
    const raw = await getAllServersApp();
    const mapped = raw.map(s => s.attributes).sort((a, b) => a.id - b.id);
    let found = mapped.find(s => String(s.id) === targetRaw);
    if (!found) {
      const no = Number(targetRaw);
      if (!isNaN(no) && no >= 1 && no <= mapped.length) found = mapped[no - 1];
    }
    if (!found) return res.status(404).json({ success: false, message: `Server No/ID ${targetRaw} ga ketemu` });
    await fetchJson(`${DOMAIN_PANEL}/api/application/servers/${found.id}`, appHeaders, { method: 'DELETE' });
    res.json({ success: true, message: `Server ${found.name} (ID ${found.id}) berhasil dihapus`, deleted: { id: found.id, name: found.name } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/servers/:id', async (req, res) => {
  try {
    await fetchJson(`${DOMAIN_PANEL}/api/application/servers/${req.params.id}`, appHeaders, { method: 'DELETE' });
    res.json({ success: true, message: `Server ID ${req.params.id} berhasil dihapus` });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/servers/delete-off', async (req, res) => {
  try {
    const raw = await getAllServersApp();
    const withStatus = await attachStatus(raw);
    const off = withStatus.filter(s => s.status === 'offline' || s.status === 'stopped');
    const results = [];
    for (const s of off) {
      try { await fetchJson(`${DOMAIN_PANEL}/api/application/servers/${s.id}`, appHeaders, { method: 'DELETE' }); results.push({ id: s.id, name: s.name, status: s.status, ok: true }); }
      catch (e) { results.push({ id: s.id, name: s.name, status: s.status, ok: false, error: e.message }); }
    }
    res.json({ success: true, message: `${results.filter(r => r.ok).length} server OFF berhasil dihapus, ${results.filter(r => !r.ok).length} gagal`, checked: withStatus.length, off_count: off.length, results });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/servers/delete-all', async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE ALL') return res.status(400).json({ success: false, message: 'Konfirmasi DELETE ALL belum dikirim' });
    const raw = await getAllServersApp();
    const servers = raw.map(s => s.attributes).sort((a, b) => a.id - b.id);
    const toDelete = servers.filter(s => String(s.id) !== '2');
    const skipped = servers.filter(s => String(s.id) === '2');
    const results = [];
    for (const s of toDelete) {
      try { await fetchJson(`${DOMAIN_PANEL}/api/application/servers/${s.id}`, appHeaders, { method: 'DELETE' }); results.push({ id: s.id, name: s.name, ok: true }); }
      catch (e) { results.push({ id: s.id, name: s.name, ok: false, error: e.message }); }
    }
    res.json({ success: true, message: `${results.filter(r => r.ok).length} server dihapus, ${skipped.length} dilewati (ID 2), ${results.filter(r => !r.ok).length} gagal`, deleted: results, skipped: skipped.map(s => ({ id: s.id, name: s.name })) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/users/delete-no-server', async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE USERS') return res.status(400).json({ success: false, message: 'Konfirmasi DELETE USERS belum dikirim' });
    const [usersRaw, serversRaw] = await Promise.all([getAllUsersApp(), getAllServersApp()]);
    const userIdsWithServer = new Set(serversRaw.map(s => s.attributes.user));
    const toDelete = usersRaw.filter(u => !userIdsWithServer.has(u.attributes.id) && String(u.attributes.id) !== '1');
    const skippedAdmin = usersRaw.filter(u => !userIdsWithServer.has(u.attributes.id) && String(u.attributes.id) === '1');
    const results = [];
    for (const u of toDelete) {
      const a = u.attributes;
      try { await fetchJson(`${DOMAIN_PANEL}/api/application/users/${a.id}`, appHeaders, { method: 'DELETE' }); results.push({ id: a.id, username: a.username, email: a.email, ok: true }); }
      catch (e) { results.push({ id: a.id, username: a.username, email: a.email, ok: false, error: e.message }); }
    }
    res.json({ success: true, message: `${results.filter(r => r.ok).length} user tanpa server dihapus, ${skippedAdmin.length} admin ID 1 dilewati, ${results.filter(r => !r.ok).length} gagal`, deleted: results, skipped_admin: skippedAdmin.map(u => ({ id: u.attributes.id, username: u.attributes.username })) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Ptero Control running on :${PORT} -> ${DOMAIN_PANEL}`));
}
module.exports = app;
