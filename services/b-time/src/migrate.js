import { openDb, migrate } from './db.js';

const db = openDb();
migrate(db);
const rows = db.prepare('SELECT version FROM _migrations ORDER BY version').all();
console.log('migrations applied:', rows.map(r => r.version).join(', '));
db.close();