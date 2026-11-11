import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('hex');
export const uid = () => randomUUID();
export const deadline = (minutes) => Date.now() + minutes * 60000;
export const moneyLimit = 100_000_000_000;
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
export function verifyPassword(password, saved) {
  const [salt, digest] = saved.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(digest, 'hex'));
}
export class Rule extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requireRule(condition, message, status) {
  if (!condition) throw new Rule(message, status);
}

const bankChargeTable = `CREATE TABLE IF NOT EXISTS bank_charges (
      id TEXT PRIMARY KEY, request TEXT NOT NULL, scope TEXT NOT NULL,
      issuer TEXT NOT NULL REFERENCES accounts(id), team TEXT NOT NULL REFERENCES accounts(id),
      description TEXT NOT NULL, rate INTEGER, amount BIGINT NOT NULL CHECK(amount >= 0),
      created BIGINT NOT NULL, paid_at BIGINT, cancelled_at BIGINT, deleted_at BIGINT,
      template_id TEXT REFERENCES bank_charge_templates(id), UNIQUE(request,team)
    );`;
const chargeTeamIndex = 'CREATE INDEX IF NOT EXISTS bank_charges_team ON bank_charges(team,created);';
const backfillChargeLaunches = `INSERT INTO bank_charge_launches
    (issuer,request,scope,description,type,value,created,template_id,recipient_count)
    SELECT issuer,request,scope,description,CASE WHEN rate IS NULL THEN 'fixed' ELSE 'percent' END,
      COALESCE(rate,MIN(amount)),MIN(created),template_id,COUNT(*) FROM bank_charges
    GROUP BY issuer,request,scope,description,rate,template_id
    ON CONFLICT(issuer,request) DO NOTHING;`;

const schema = `
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','student','team')),
      username TEXT UNIQUE, password TEXT, cnpj TEXT UNIQUE, card TEXT UNIQUE,
      balance BIGINT NOT NULL DEFAULT 0 CHECK(balance >= 0), deleted_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS members (
      team TEXT NOT NULL REFERENCES accounts(id), student TEXT NOT NULL UNIQUE REFERENCES accounts(id),
      PRIMARY KEY(team, student)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL, pairing TEXT UNIQUE,
      team TEXT UNIQUE REFERENCES accounts(id), seen BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS device_discovery (
      id TEXT NOT NULL, key TEXT NOT NULL, seen BIGINT NOT NULL, PRIMARY KEY(id,key)
    );
    CREATE TABLE IF NOT EXISTS device_exchange (
      id INTEGER PRIMARY KEY CHECK(id=1), key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('sale','card')),
      owner TEXT NOT NULL REFERENCES accounts(id), device TEXT REFERENCES devices(id),
      method TEXT NOT NULL, amount BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', detail TEXT,
      created BIGINT NOT NULL, expires BIGINT NOT NULL, actor TEXT REFERENCES accounts(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_device_operation ON operations(device)
      WHERE status = 'pending' AND device IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_sale ON operations(owner)
      WHERE status = 'pending' AND kind = 'sale';
    CREATE UNIQUE INDEX IF NOT EXISTS one_card_operation ON operations(owner)
      WHERE status = 'pending' AND kind = 'card';
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY, payer TEXT REFERENCES accounts(id), payee TEXT NOT NULL REFERENCES accounts(id),
      amount BIGINT NOT NULL CHECK(amount > 0), method TEXT NOT NULL,
      created BIGINT NOT NULL, actor TEXT REFERENCES accounts(id), request TEXT UNIQUE, archived_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS ledger_payer ON ledger(payer,created);
    CREATE INDEX IF NOT EXISTS ledger_payee ON ledger(payee,created);
    CREATE TABLE IF NOT EXISTS terminal_fee_config (
      id INTEGER PRIMARY KEY CHECK(id=1), rate INTEGER NOT NULL CHECK(rate BETWEEN 0 AND 10000)
    );
    CREATE TABLE IF NOT EXISTS terminal_fees (
      sale TEXT PRIMARY KEY REFERENCES ledger(id), charge TEXT NOT NULL UNIQUE REFERENCES ledger(id)
    );
    CREATE TABLE IF NOT EXISTS refunds (
      original TEXT PRIMARY KEY REFERENCES ledger(id), reversal TEXT NOT NULL UNIQUE REFERENCES ledger(id)
    );
    CREATE TABLE IF NOT EXISTS credit_batches (
      request TEXT PRIMARY KEY, amount BIGINT NOT NULL, recipients INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bank_charge_templates (
      id TEXT PRIMARY KEY, issuer TEXT NOT NULL REFERENCES accounts(id), scope TEXT NOT NULL,
      description TEXT NOT NULL, type TEXT NOT NULL, value BIGINT NOT NULL, deleted_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS bank_charge_launches (
      issuer TEXT NOT NULL REFERENCES accounts(id), request TEXT NOT NULL, scope TEXT NOT NULL,
      description TEXT NOT NULL, type TEXT NOT NULL, value BIGINT NOT NULL, created BIGINT NOT NULL,
      template_id TEXT REFERENCES bank_charge_templates(id), recipient_count INTEGER NOT NULL,
      PRIMARY KEY(issuer,request)
    );
    ${bankChargeTable}
    ${chargeTeamIndex}
    CREATE TABLE IF NOT EXISTS pix_keys (
      id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), type TEXT NOT NULL,
      value TEXT NOT NULL, UNIQUE(type,value)
    );
    CREATE INDEX IF NOT EXISTS pix_keys_account ON pix_keys(account);
    CREATE TABLE IF NOT EXISTS tap_events (
      device TEXT NOT NULL, nonce TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY(device,nonce)
    );
`;

async function inTransaction(exec, begin, work) {
  await exec(begin);
  try {
    const result = await work();
    await exec('COMMIT');
    return result;
  } catch (error) {
    await exec('ROLLBACK');
    throw error;
  }
}

export async function openDb(file, connectionString) {
  if (connectionString) return openPostgres(connectionString);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  const exec = sql => sqlite.exec(sql);
  exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  await inTransaction(exec, 'BEGIN IMMEDIATE', () => {
    exec(schema);
    if (!sqlite.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'deleted_at')) {
      exec('ALTER TABLE accounts ADD COLUMN deleted_at BIGINT');
    }
    if (!sqlite.prepare('PRAGMA table_info(operations)').all().some(column => column.name === 'actor')) {
      exec('ALTER TABLE operations ADD COLUMN actor TEXT REFERENCES accounts(id)');
    }
    if (!sqlite.prepare('PRAGMA table_info(ledger)').all().some(column => column.name === 'archived_at')) {
      exec('ALTER TABLE ledger ADD COLUMN archived_at BIGINT');
    }
    const chargeColumns = sqlite.prepare('PRAGMA table_info(bank_charges)').all().map(column => column.name);
    if (!chargeColumns.includes('deleted_at')) exec('ALTER TABLE bank_charges ADD COLUMN deleted_at BIGINT');
    if (!chargeColumns.includes('template_id')) exec('ALTER TABLE bank_charges ADD COLUMN template_id TEXT REFERENCES bank_charge_templates(id)');
    const chargeSql = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='bank_charges'").get().sql;
    if (/amount\s*>\s*0/i.test(chargeSql)) {
      exec('ALTER TABLE bank_charges RENAME TO bank_charges_old');
      exec(bankChargeTable);
      exec(`INSERT INTO bank_charges (id,request,scope,issuer,team,description,rate,amount,created,paid_at,cancelled_at,deleted_at,template_id)
        SELECT id,request,scope,issuer,team,description,rate,amount,created,paid_at,cancelled_at,deleted_at,template_id FROM bank_charges_old`);
      exec('DROP TABLE bank_charges_old');
      exec(chargeTeamIndex);
    }
    exec(backfillChargeLaunches);
  });
  const connection = {
    get: (sql, args) => sqlite.prepare(sql).get(...args),
    all: (sql, args) => sqlite.prepare(sql).all(...args),
    run: (sql, args) => sqlite.prepare(sql).run(...args)
  };
  // Queue standalone queries as well so none can join another request's transaction.
  let pending = Promise.resolve();
  function enqueue(work) {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  }
  return {
    get: (sql, args) => enqueue(() => connection.get(sql, args)),
    all: (sql, args) => enqueue(() => connection.all(sql, args)),
    run: (sql, args) => enqueue(() => connection.run(sql, args)),
    transaction: work => enqueue(() => inTransaction(exec, 'BEGIN IMMEDIATE', () => work(connection))),
    close: () => enqueue(() => sqlite.close())
  };
}

function postgresCommands(client) {
  function query(sql, args) {
    let index = 0;
    return client.query(sql.replace(/\?/g, () => '$' + ++index), args);
  }
  return {
    get: async (sql, args) => (await query(sql, args)).rows[0],
    all: async (sql, args) => (await query(sql, args)).rows,
    run: async (sql, args) => ({ changes: (await query(sql, args)).rowCount })
  };
}

async function openPostgres(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 8000,
    // Application balances and timestamps fit within JavaScript's safe integer range.
    types: { getTypeParser: (oid, format) => oid === 20 ? Number : pg.types.getTypeParser(oid, format) }
  });
  pool.on('error', error => console.warn('Conexão PostgreSQL encerrada:', error.code || error.name));
  async function postgresTransaction(work) {
    const client = await pool.connect();
    try {
      return await inTransaction(sql => client.query(sql), 'BEGIN', async () => {
        // Serialize financial and enrollment writes, including across overlapping deployments.
        await client.query('SELECT pg_advisory_xact_lock(783616404)');
        return work(postgresCommands(client), sql => client.query(sql));
      });
    } finally {
      client.release();
    }
  }
  try {
    await postgresTransaction(async (db, exec) => {
      await exec(schema);
      await exec('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at BIGINT');
      await exec('ALTER TABLE operations ADD COLUMN IF NOT EXISTS actor TEXT REFERENCES accounts(id)');
      await exec('ALTER TABLE ledger ADD COLUMN IF NOT EXISTS archived_at BIGINT');
      await exec('ALTER TABLE bank_charges ADD COLUMN IF NOT EXISTS deleted_at BIGINT');
      await exec('ALTER TABLE bank_charges ADD COLUMN IF NOT EXISTS template_id TEXT REFERENCES bank_charge_templates(id)');
      const amountConstraint = await get(db, `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='bank_charges'::regclass AND conname='bank_charges_amount_check'`);
      if (/amount\s*>\s*0/i.test(amountConstraint?.definition || '')) {
        await exec('ALTER TABLE bank_charges DROP CONSTRAINT bank_charges_amount_check, ADD CONSTRAINT bank_charges_amount_check CHECK(amount >= 0)');
      }
      await exec(backfillChargeLaunches);
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    ...postgresCommands(pool),
    run: (sql, args) => postgresTransaction(connection => connection.run(sql, args)),
    transaction: postgresTransaction,
    close: () => pool.end()
  };
}

export const get = (db, sql, ...args) => db.get(sql, args);
export const all = (db, sql, ...args) => db.all(sql, args);
export const run = (db, sql, ...args) => db.run(sql, args);
export const transaction = (db, work) => db.transaction(work);
export const expire = db => run(db, "UPDATE operations SET status='expired' WHERE status='pending' AND expires<=?", Date.now());
export async function terminalFeeRate(db) {
  return (await get(db, 'SELECT rate FROM terminal_fee_config WHERE id=1'))?.rate ?? 0;
}

export async function transfer(db, { id = uid(), payer = null, payee, amount, method, actor, request = null }) {
  if (request && await get(db, 'SELECT 1 FROM ledger WHERE request=?', request)) return;
  const recipient = await get(db, 'SELECT balance FROM accounts WHERE id=? AND deleted_at IS NULL', payee);
  requireRule(recipient, 'Conta de destino não encontrada.', 404);
  requireRule(recipient.balance + amount <= moneyLimit, 'A conta de destino atingiu o limite de saldo.');
  if (payer) {
    const debit = await run(db, 'UPDATE accounts SET balance=balance-? WHERE id=? AND balance>=? AND deleted_at IS NULL', amount, payer, amount);
    requireRule(debit.changes, 'Saldo insuficiente.', 409);
  }
  await run(db, 'UPDATE accounts SET balance=balance+? WHERE id=?', amount, payee);
  await run(db, 'INSERT INTO ledger (id,payer,payee,amount,method,created,actor,request) VALUES (?,?,?,?,?,?,?,?)',
    id, payer, payee, amount, method, Date.now(), actor, request);
}
export async function settle(db, op, payer, method, actor = payer) {
  requireRule(op.status === 'pending' && op.method === method, 'Esta cobrança não está disponível.', 409);
  await transfer(db, { id: op.id, payer, payee: op.owner, amount: op.amount, method, actor });
  if (method === 'rfid') {
    const fee = Math.round(op.amount * await terminalFeeRate(db) / 10000);
    if (fee > 0) {
      const bank = await get(db, "SELECT id FROM accounts WHERE role='admin' AND deleted_at IS NULL");
      requireRule(bank, 'Conta do banco indisponível.', 409);
      const charge = uid();
      await transfer(db, { id: charge, payer: op.owner, payee: bank.id, amount: fee, method: 'terminal_fee', actor });
      await run(db, 'INSERT INTO terminal_fees (sale,charge) VALUES (?,?)', op.id, charge);
    }
  }
  await run(db, "UPDATE operations SET status='paid',detail=NULL WHERE id=?", op.id);
}
export function activity(db, account) {
  return all(db, `SELECT l.id,l.amount,l.method,l.created,l.payer,l.payee,p.name AS "fromName",r.name AS "toName"
    FROM ledger l LEFT JOIN accounts p ON p.id=l.payer JOIN accounts r ON r.id=l.payee
    WHERE l.archived_at IS NULL AND (l.payer=? OR l.payee=?) ORDER BY l.created DESC LIMIT 40`, account, account);
}
export function initAdmin(db, username, password) {
  return transaction(db, async db => {
    if (await get(db, "SELECT id FROM accounts WHERE role='admin'")) return;
    requireRule(username && typeof password === 'string' && password.length >= 10,
      'Defina ADMIN_USER e ADMIN_PASSWORD (mínimo de 10 caracteres) antes de iniciar.');
    await run(db, "INSERT INTO accounts (id,name,role,username,password) VALUES (?,'Gestor','admin',?,?)",
      uid(), username.toLowerCase().trim(), passwordHash(password));
  });
}
