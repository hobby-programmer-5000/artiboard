import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openSqlite } from '../server/store/sqlite.js';
import { makeFlow } from '../server/flow.js';

test('a malformed request gets a client error and the same server keeps answering', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/http-site.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  try {
    const [said] = await once(child.stdout, 'data');
    const port = Number(String(said).trim());
    const get = (path) => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(await get('//[invalid]/'), 400, stderr);
    assert.equal(await get('/api/config'), 200, 'the request did not terminate the process');
  } finally {
    if (child.exitCode == null) child.kill();
    await exited;
  }
});

test('an accepted reassignment and its version survive opening a second SQLite store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artiboard-owner-'));
  const file = join(dir, 'board.db'), site = 'http://localhost';
  const store = openSqlite({ file, boardUrl: site });
  try {
    const ana = await store.addMember({ person: 'ana' }), ben = await store.addMember({ person: 'ben' });
    await store.createProject(null, { id: 'owners', title: 'Owners' });
    await store.apply(null, 'owners', [{ op: 'set', path: 'tasks/T-1', data: { key: 'T-1', status: 'todo' } }]);
    const flow = makeFlow(store);
    await flow.claim(ana, 'owners', 'T-1');
    await flow.batch(ana, 'owners', [{ op: 'update', path: 'tasks/T-1', data: { owner: ben.person } }]);
    const before = await store.get('owners', 'tasks/T-1');
    const again = openSqlite({ file, boardUrl: site });
    try {
      const after = await again.get('owners', 'tasks/T-1');
      assert.equal(after.data.owner, 'ben');
      assert.equal(after.version, before.version, 'opening a current database does not rewrite its task');
      assert.equal(after.updated_at, before.updated_at);
    } finally { again.close(); }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
