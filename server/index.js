import { resolve } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';

if (process.env.RAILWAY_DEPLOYMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  throw new Error('Anexe um volume persistente ao serviço do Railway antes de iniciar.');
}
const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
const db = openDb(process.env.DB_PATH || resolve(dir, 'banco.sqlite'));
const { app, close } = createApp(db);
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => console.log('Banco Virtual em http://localhost:' + server.address().port));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    close();
    server.close(() => db.close());
  });
}
