import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

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

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','student','team')),
      username TEXT UNIQUE, password TEXT, cnpj TEXT UNIQUE, card TEXT UNIQUE,
      balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0), deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS members (
      team TEXT NOT NULL REFERENCES accounts(id), student TEXT NOT NULL UNIQUE REFERENCES accounts(id),
      PRIMARY KEY(team, student)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL, pairing TEXT UNIQUE,
      team TEXT UNIQUE REFERENCES accounts(id), seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('sale','card')),
      owner TEXT NOT NULL REFERENCES accounts(id), device TEXT REFERENCES devices(id),
      method TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', detail TEXT,
      created INTEGER NOT NULL, expires INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_device_operation ON operations(device)
      WHERE status = 'pending' AND device IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_sale ON operations(owner)
      WHERE status = 'pending' AND kind = 'sale';
    CREATE UNIQUE INDEX IF NOT EXISTS one_card_operation ON operations(owner)
      WHERE status = 'pending' AND kind = 'card';
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY, payer TEXT REFERENCES accounts(id), payee TEXT NOT NULL REFERENCES accounts(id),
      amount INTEGER NOT NULL CHECK(amount > 0), method TEXT NOT NULL,
      created INTEGER NOT NULL, actor TEXT REFERENCES accounts(id), request TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS ledger_payer ON ledger(payer,created);
    CREATE INDEX IF NOT EXISTS ledger_payee ON ledger(payee,created);
    CREATE TABLE IF NOT EXISTS tap_events (
      device TEXT NOT NULL, nonce TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(device,nonce)
    );
  `);
  transaction(db, () => {
    if (!all(db, 'PRAGMA table_info(accounts)').some(column => column.name === 'deleted_at')) {
      db.exec('ALTER TABLE accounts ADD COLUMN deleted_at INTEGER');
    }
  });
  return db;
}
export const get = (db, sql, ...args) => db.prepare(sql).get(...args);
export const all = (db, sql, ...args) => db.prepare(sql).all(...args);
export const run = (db, sql, ...args) => db.prepare(sql).run(...args);
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function expire(db) {
  run(db, "UPDATE operations SET status='expired' WHERE status='pending' AND expires<=?", Date.now());
}
export function transfer(db, { id = uid(), payer = null, payee, amount, method, actor, request = null }) {
  if (request && get(db, 'SELECT 1 FROM ledger WHERE request=?', request)) return;
  const recipient = get(db, 'SELECT balance FROM accounts WHERE id=? AND deleted_at IS NULL', payee);
  requireRule(recipient, 'Conta de destino não encontrada.', 404);
  requireRule(recipient.balance + amount <= moneyLimit, 'A conta de destino atingiu o limite de saldo.');
  if (payer) {
    const debit = run(db, 'UPDATE accounts SET balance=balance-? WHERE id=? AND balance>=? AND deleted_at IS NULL', amount, payer, amount);
    requireRule(debit.changes, 'Saldo insuficiente.', 409);
  }
  run(db, 'UPDATE accounts SET balance=balance+? WHERE id=?', amount, payee);
  run(db, 'INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?)', id, payer, payee, amount, method, Date.now(), actor, request);
}
export function settle(db, op, payer, method) {
  requireRule(op.status === 'pending' && op.method === method, 'Esta cobrança não está disponível.', 409);
  transfer(db, { id: op.id, payer, payee: op.owner, amount: op.amount, method, actor: payer });
  run(db, "UPDATE operations SET status='paid',detail=NULL WHERE id=?", op.id);
}
export function activity(db, account) {
  return all(db, `SELECT l.id,l.amount,l.method,l.created,l.payer,l.payee,p.name AS fromName,r.name AS toName
    FROM ledger l LEFT JOIN accounts p ON p.id=l.payer JOIN accounts r ON r.id=l.payee
    WHERE l.payer=? OR l.payee=? ORDER BY l.created DESC LIMIT 40`, account, account);
}
export function initAdmin(db, username, password) {
  if (!get(db, "SELECT id FROM accounts WHERE role='admin'")) {
    requireRule(username && typeof password === 'string' && password.length >= 10,
      'Defina ADMIN_USER e ADMIN_PASSWORD (mínimo de 10 caracteres) antes de iniciar.');
    run(db, "INSERT INTO accounts (id,name,role,username,password) VALUES (?,'Gestor','admin',?,?)",
      uid(), username.toLowerCase().trim(), passwordHash(password));
  }
}
