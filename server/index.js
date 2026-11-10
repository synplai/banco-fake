import { resolve } from 'node:path';
import { openDb, Rule } from './db.js';
import { createApp } from './app.js';

const { DATABASE_URL, DB_PATH, RAILWAY_DEPLOYMENT_ID, RAILWAY_VOLUME_MOUNT_PATH } = process.env;
if (RAILWAY_DEPLOYMENT_ID && !DATABASE_URL && !RAILWAY_VOLUME_MOUNT_PATH) {
  throw new Error('Defina DATABASE_URL para PostgreSQL ou anexe um volume persistente para SQLite.');
}
let db;
let bank;
try {
  db = await openDb(DB_PATH || resolve(RAILWAY_VOLUME_MOUNT_PATH || './data', 'banco.sqlite'), DATABASE_URL);
  bank = await createApp(db);
} catch (error) {
  await db?.close();
  if (!DATABASE_URL || error instanceof Rule) throw error;
  console.error('Não foi possível inicializar o PostgreSQL. Confira DATABASE_URL e o serviço do banco.',
    error.code || error.name);
  process.exit(1);
}
const { app, close } = bank;
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => console.log(
  'Banco Virtual em http://localhost:' + server.address().port + (DATABASE_URL ? ' · PostgreSQL' : ' · SQLite')));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    close();
    server.close(() => db.close());
  });
}
