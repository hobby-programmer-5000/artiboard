import { createServer } from 'node:http';
import { makeApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { openSqlite } from '../../server/store/sqlite.js';

const store = openSqlite({ file: ':memory:', boardUrl: 'http://localhost' });
const handle = makeApp({ store, cfg: loadConfig({}) });
const server = createServer((req, res) => handle(req, res));
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
