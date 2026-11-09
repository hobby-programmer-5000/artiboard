import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createClient } from '@supabase/supabase-js';

const SHIM = readFileSync(new URL('../server/public/shim.js', import.meta.url), 'utf8');
async function until(check) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), 'the listener reached the expected state');
}
const row = (id, data = { key: id }, version = 1, collection = 'tasks') => ({ collection, doc_id: id, data, version, updated_at: '2026-01-01T00:00:10.000Z' });

async function sqliteRuntime(rows) {
  const state = { rows, reads: [], stream: null, visible: null, defer: null };
  const window = { addEventListener() {} };
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  runInNewContext(SHIM, {
    window, setTimeout, clearTimeout, setInterval: () => 0,
    document: { hidden: false, getElementById: () => null, addEventListener(k, fn) { if (k === 'visibilitychange') state.visible = fn; } },
    location: { pathname: '/p/demo', hash: '', search: '' }, history: { replaceState() {} },
    EventSource: function () { state.stream = this; },
    fetch: async (url, opts) => {
      if (url === '/api/config') return json({ backend: 'sqlite', lang: 'en' });
      if (url === '/api/me') return json({ uid: 'u', person: 'ana', role: 'member' });
      const body = JSON.parse(opts.body);
      state.reads.push(body);
      const ordered = (collection, order = [], limit) => {
        const found = state.rows.filter((r) => r.collection === collection).slice();
        found.sort((a, b) => {
          for (const o of order) {
            const x = a.data[o.field], y = b.data[o.field];
            if (x !== y) return (x < y ? -1 : 1) * (o.dir === 'desc' ? -1 : 1);
          }
          return a.doc_id.localeCompare(b.doc_id);
        });
        return found.slice(0, limit);
      };
      let found;
      if (body.collections) found = state.rows.filter((r) => body.collections.includes(r.collection) && r.updated_at > body.since);
      else if (body.collection) found = ordered(body.collection, body.order, body.limit);
      else if (body.limited) found = body.limited.flatMap((r, i) => ordered(r.collection, r.order, r.limit).map((d) => ({ ...d, i })));
      else found = state.rows.filter((r) => body.whole.includes(r.collection) || body.docs?.[r.collection]?.includes(r.doc_id));
      const result = json(structuredClone(found));
      if (state.defer) { const hold = state.defer; state.defer = null; return hold(result); }
      return result;
    },
  });
  state.db = await window.claude.use('db');
  state.push = (r, gone = false) => state.stream.onmessage({ data: JSON.stringify({ ...r, ...(gone && { gone: true }) }) });
  return state;
}

test('reconnecting reconciles deletes, including an empty result', async () => {
  const rt = await sqliteRuntime([row('A'), row('B')]);
  let ids;
  rt.db.collection('tasks').onSnapshot((s) => { ids = s.docs.map((d) => d.id).join(','); });
  await until(() => ids === 'A,B');
  rt.stream.onerror();
  rt.rows = [row('B')];
  rt.stream.onopen();
  await until(() => ids === 'B');
  rt.stream.onerror();
  rt.rows = [];
  rt.stream.onopen();
  await until(() => ids === '');
});

test('an initially empty listener catches up on reconnect and returning to the tab', async () => {
  const rt = await sqliteRuntime([]);
  let ids;
  rt.db.collection('tasks').onSnapshot((s) => { ids = s.docs.map((d) => d.id).join(','); });
  await until(() => ids === '');
  rt.stream.onerror();
  rt.rows = [row('A')];
  rt.stream.onopen();
  await until(() => ids === 'A');
  rt.rows = [row('B')];
  rt.visible();
  await until(() => ids === 'B');
});

test('a limited message listener refills after a delete and an ordering change', async () => {
  const collection = 'tasks/T-1/messages';
  const older = row('old', { at: '2026-01-01T00:00:01Z' }, 1, collection);
  const latest = row('new', { at: '2026-01-01T00:00:02Z' }, 1, collection);
  const rt = await sqliteRuntime([older, latest]);
  let ids;
  rt.db.collection(collection).orderBy('at', 'desc').limit(1).onSnapshot((s) => { ids = s.docs.map((d) => d.id).join(','); });
  await until(() => ids === 'new');
  rt.rows = [older];
  rt.push(latest, true);
  await until(() => ids === 'old');
  const moved = row('new', { at: '2026-01-01T00:00:03Z' }, 2, collection);
  rt.rows.push(moved);
  rt.push(moved);
  await until(() => ids === 'new');
  const earlier = row('new', { at: '2026-01-01T00:00:00Z' }, 3, collection);
  rt.rows = [older, earlier];
  rt.push(earlier);
  await until(() => ids === 'old');
});

test('a reconnect ignores a stale first read and retains changes pushed during its replacement', async () => {
  const rt = await sqliteRuntime([row('A')]);
  let first, replacement, ids;
  rt.defer = (result) => new Promise((resolve) => { first = () => resolve(result); });
  rt.db.collection('tasks').onSnapshot((s) => { ids = s.docs.map((d) => d.id).sort().join(','); });
  await until(() => !!first);
  rt.rows = [row('B')];
  rt.defer = (result) => new Promise((resolve) => { replacement = () => resolve(result); });
  rt.stream.onopen();
  await until(() => !!replacement);
  rt.rows.push(row('C'));
  rt.push(row('C'));
  replacement();
  await until(() => ids === 'B,C');
  first();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ids, 'B,C');
});

test('Supabase whole reads cross a service row cap using ordered continuation pages', async () => {
  const stored = Array.from({ length: 1005 }, (_, i) => ({ ...row(`T-${String(i).padStart(4, '0')}`), project: 'demo' }));
  const queries = [];
  const client = createClient('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url) => {
      const u = new URL(String(url));
      queries.push(u);
      let selected = stored.slice();
      for (const filter of u.searchParams.getAll('or')) {
        const cursor = /collection\.gt\.("(?:\\.|[^"\\])*"),and\(collection\.eq\.\1,doc_id\.gt\.("(?:\\.|[^"\\])*")\)/.exec(filter);
        if (cursor) {
          const c = JSON.parse(cursor[1]), id = JSON.parse(cursor[2]);
          selected = selected.filter((r) => r.collection > c || (r.collection === c && r.doc_id > id));
        }
      }
      selected.sort((a, b) => a.collection.localeCompare(b.collection) || a.doc_id.localeCompare(b.doc_id));
      return new Response(JSON.stringify(selected.slice(0, 137)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const channel = { on() { return this; }, subscribe() { return this; } };
  const sb = { from: (...args) => client.from(...args), channel: () => channel,
    auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic' } } }) },
    rpc: async () => ({ data: { user_id: 'u', person: 'ana', role: 'member' } }) };
  const window = { supabase: { createClient: () => sb }, addEventListener() {} };
  runInNewContext(SHIM, {
    window, setTimeout, clearTimeout, setInterval: () => 0,
    document: { addEventListener() {}, getElementById: () => null },
    location: { pathname: '/p/demo', hash: '', search: '' }, history: { replaceState() {} },
    fetch: async () => ({ json: async () => ({ backend: 'supabase', lang: 'en', supabaseUrl: 'https://synthetic.invalid', supabaseKey: 'synthetic' }) }),
  });
  const db = await window.claude.use('db');
  const found = await db.collection('tasks').get();
  assert.equal(found.docs.length, stored.length);
  assert.equal(new Set(found.docs.map((d) => d.id)).size, stored.length);
  assert.ok(queries.length > 1);
  assert.ok(queries.every((q) => q.searchParams.get('order') === 'collection.asc,doc_id.asc'), 'every page uses the unique row identity order');
});
