import express from 'express';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import {
  activity, all, deadline, expire, get, hash, initAdmin, moneyLimit, passwordHash,
  requireRule as check, Rule, run, secret, settle, transaction, transfer, uid, verifyPassword
} from './db.js';
import { bridge } from './mqtt.js';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const scanner = fileURLToPath(new URL('../node_modules/jsqr/dist/jsQR.js', import.meta.url));
const login = /^[a-z0-9._-]{3,40}$/;
const normalize = value => typeof value === 'string' ? value.trim() : '';
const userFields = 'id,name,role,username,cnpj,balance,CAST(card IS NOT NULL AS INTEGER) AS "hasCard"';
const deviceFields = 'd.id,d.name,d.team,d.seen,a.name AS "teamName"';
const lastMinute = () => Date.now() - 25000;
const publicDevice = d => ({ ...d, online: d.seen >= lastMinute() });

function sessionToken(req) {
  return /(?:^|;\s*)feira=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
}
function amount(value) {
  check(Number.isSafeInteger(value) && value > 0 && value <= moneyLimit, 'Informe um valor válido em reais.');
  return value;
}

export async function createApp(db, config = process.env) {
  await initAdmin(db, config.ADMIN_USER, config.ADMIN_PASSWORD);
  const streams = new Map();
  const changed = async () => {
    const snapshot = Array.from(streams);
    if (!snapshot.length) return;
    try {
      const tokens = snapshot.map(([, token]) => token);
      const placeholders = tokens.map(() => '?').join(',');
      const sessions = await all(db, 'SELECT token FROM sessions WHERE expires>? AND token IN (' + placeholders + ')',
        Date.now(), ...tokens);
      const active = new Set(sessions.map(session => session.token));
      for (const [res, token] of snapshot) {
        if (res.writableEnded || res.destroyed) continue;
        if (!active.has(token)) res.end();
        else if (!res.writableNeedDrain) res.write('event: update\ndata: {}\n\n');
      }
    } catch (error) {
      console.warn('Falha ao atualizar conexões do site:', error.code || error.name);
    }
  };
  const tick = setInterval(changed, 10000).unref();
  const mqtt = bridge(db, config, changed);
  const app = express();
  const api = express.Router();
  const attempts = new Map();
  const secure = config.COOKIE_SECURE === 'true' || Boolean(config.RAILWAY_DEPLOYMENT_ID);
  const cookie = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
  const dummy = passwordHash(secret());
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    next();
  });
  app.get('/health', async (req, res) => {
    await get(db, 'SELECT 1');
    res.json({ ok: true });
  });
  app.get('/vendor/jsqr.js', (req, res) => res.sendFile(scanner));
  app.use('/api', api);
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      check(req.is('application/json'), 'Envie dados em JSON.', 415);
      check(req.headers['sec-fetch-site'] !== 'cross-site', 'Origem inválida.', 403);
    }
    next();
  });
  api.use(express.json({ limit: '12kb' }));
  api.use((req, res, next) => {
    if (req.method !== 'GET') {
      check(req.body && !Array.isArray(req.body) && typeof req.body === 'object', 'Dados inválidos.');
      res.on('finish', () => { if (res.statusCode < 300) changed(); });
    }
    next();
  });
  api.post('/login', async (req, res) => {
    const username = normalize(req.body.username).toLowerCase();
    const password = req.body.password;
    check(login.test(username) && typeof password === 'string' && password.length <= 128,
      'Usuário ou senha inválidos.', 401);
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    const ip = secure ? req.headers['x-forwarded-for']?.split(',').at(-1)?.trim() || req.ip : req.ip;
    const throttleKey = ip + '|' + username;
    const tally = attempts.get(throttleKey) || { count: 0, until: deadline(5) };
    check(tally.count < 8, 'Muitas tentativas. Aguarde alguns minutos.', 429);
    const account = await get(db, 'SELECT id,password FROM accounts WHERE username=?', username);
    if (!verifyPassword(password, account?.password || dummy) || !account) {
      tally.count++;
      if (attempts.size < 5000) attempts.set(throttleKey, tally);
      throw new Rule('Usuário ou senha inválidos.', 401);
    }
    attempts.delete(throttleKey);
    const token = secret();
    await transaction(db, async db => {
      check(await get(db, 'SELECT 1 FROM accounts WHERE id=? AND username=? AND password=?',
        account.id, username, account.password), 'Usuário ou senha inválidos.', 401);
      await run(db, 'DELETE FROM sessions WHERE expires<=? OR token=?', now, hash(sessionToken(req) || ''));
      await run(db, 'INSERT INTO sessions VALUES (?,?,?)', hash(token), account.id, deadline(720));
    });
    res.cookie('feira', token, { ...cookie, maxAge: 12 * 3600000 }).json({ ok: true });
  });
  api.use(async (req, res, next) => {
    const token = sessionToken(req);
    const session = token && await get(db, 'SELECT account FROM sessions WHERE token=? AND expires>?', hash(token), Date.now());
    check(session, 'Entre na sua conta para continuar.', 401);
    req.user = await get(db, 'SELECT ' + userFields + ' FROM accounts WHERE id=? AND deleted_at IS NULL', session.account);
    check(req.user, 'Entre na sua conta para continuar.', 401);
    next();
  });
  api.post('/logout', async (req, res) => {
    await run(db, 'DELETE FROM sessions WHERE token=?', hash(sessionToken(req)));
    res.clearCookie('feira', cookie).json({ ok: true });
  });
  api.get('/events', async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\nevent: update\ndata: {}\n\n');
    streams.set(res, hash(sessionToken(req)));
    res.on('close', () => streams.delete(res));
  });

  const manager = req => check(req.user.role === 'admin', 'Acesso reservado ao gestor.', 403);
  const student = req => check(req.user.role === 'student', 'Acesse com uma conta de aluno.', 403);
  async function teamAccess(db, req, team) {
    student(req);
    check(await get(db, 'SELECT 1 FROM members WHERE team=? AND student=?', team, req.user.id),
      'Você não faz parte deste estabelecimento.', 403);
  }
  const devices = async (where = '', ...args) => (await all(db, 'SELECT ' + deviceFields +
    ' FROM devices d LEFT JOIN accounts a ON a.id=d.team ' + where + ' ORDER BY d.name', ...args)).map(publicDevice);
  const operation = (db, id) => get(db, 'SELECT * FROM operations WHERE id=?', id);

  api.get('/home', async (req, res) => {
    await expire(db);
    const user = req.user;
    if (user.role === 'admin') {
      const accounts = await all(db, "SELECT " + userFields + " FROM accounts WHERE role<>'admin' AND deleted_at IS NULL ORDER BY name");
      const members = await all(db, 'SELECT team,student FROM members');
      return res.json({ user, accounts, members, devices: await devices(), mqtt: mqtt.ready(), activity: await all(db,
        'SELECT l.id,l.amount,l.method,l.created,p.name AS "fromName",r.name AS "toName" FROM ledger l LEFT JOIN accounts p ON p.id=l.payer JOIN accounts r ON r.id=l.payee ORDER BY l.created DESC LIMIT 40') });
    }
    const teams = await all(db, 'SELECT a.id,a.name,a.cnpj,a.balance FROM accounts a JOIN members m ON a.id=m.team WHERE m.student=?', user.id);
    for (const team of teams) {
      team.activity = await activity(db, team.id);
      team.device = (await devices('WHERE d.team=?', team.id))[0] || null;
      team.sale = await get(db, "SELECT * FROM operations WHERE owner=? AND kind='sale' ORDER BY (status='pending') DESC,created DESC,id DESC LIMIT 1", team.id) || null;
    }
    res.json({ user, teams, activity: await activity(db, user.id), devices: await devices('WHERE d.team IS NOT NULL'),
      card: await get(db, "SELECT * FROM operations WHERE owner=? AND kind='card' ORDER BY (status='pending') DESC,created DESC,id DESC LIMIT 1", user.id) || null });
  });

  api.post(['/admin/students', '/admin/students/:id/edit'], async (req, res) => {
    manager(req);
    const { id } = req.params;
    const name = normalize(req.body.name);
    const username = normalize(req.body.username).toLowerCase();
    const password = req.body.password ?? '';
    check(name.length >= 2 && name.length <= 70 && login.test(username),
      'Informe um nome e um usuário de 3 a 40 caracteres.');
    check((id && password === '') || (typeof password === 'string' && password.length >= 8 && password.length <= 128),
      'A senha deve ter de 8 a 128 caracteres.');
    await transaction(db, async db => {
      if (id) check(await get(db, "SELECT 1 FROM accounts WHERE id=? AND role='student' AND deleted_at IS NULL", id), 'Aluno não encontrado.', 404);
      check(!await get(db, 'SELECT 1 FROM accounts WHERE username=? AND id<>?', username, id || ''), 'Este usuário já existe.', 409);
      const digest = password ? passwordHash(password) : null;
      if (id) {
        await run(db, 'UPDATE accounts SET name=?,username=?,password=COALESCE(?,password) WHERE id=?', name, username, digest, id);
        if (digest) await run(db, 'DELETE FROM sessions WHERE account=?', id);
      } else {
        await run(db, "INSERT INTO accounts (id,name,role,username,password) VALUES (?,?,'student',?,?)", uid(), name, username, digest);
      }
    });
    res.status(id ? 200 : 201).json({ ok: true });
  });
  api.post(['/admin/teams', '/admin/teams/:id/edit'], async (req, res) => {
    manager(req);
    const { id } = req.params;
    const name = normalize(req.body.name);
    const cnpj = normalize(req.body.cnpj).toUpperCase().replace(/[./\s-]/g, '');
    const members = req.body.members;
    check(name.length >= 2 && name.length <= 70 && /^[A-Z0-9]{12}\d{2}$/.test(cnpj),
      'Informe o nome e um CNPJ fictício com 14 caracteres.');
    check(Array.isArray(members) && members.length > 0 &&
      new Set(members).size === members.length && members.every(member => typeof member === 'string'),
      'Selecione pelo menos um aluno. Cada aluno pode ser selecionado uma única vez.');
    await transaction(db, async db => {
      if (id) check(await get(db, "SELECT 1 FROM accounts WHERE id=? AND role='team' AND deleted_at IS NULL", id), 'Estabelecimento não encontrado.', 404);
      const team = id || uid();
      check(!await get(db, 'SELECT 1 FROM accounts WHERE cnpj=? AND id<>?', cnpj, team), 'Este CNPJ já está cadastrado.', 409);
      for (const member of members) {
        check(await get(db, "SELECT 1 FROM accounts WHERE id=? AND role='student' AND deleted_at IS NULL", member), 'Aluno inválido.');
        check(!await get(db, 'SELECT 1 FROM members WHERE student=? AND team<>?', member, team),
          'Um dos alunos já pertence a outro estabelecimento.', 409);
      }
      if (id) {
        await run(db, 'UPDATE accounts SET name=?,cnpj=? WHERE id=?', name, cnpj, team);
        await run(db, 'DELETE FROM members WHERE team=?', team);
      } else {
        await run(db, "INSERT INTO accounts (id,name,role,cnpj) VALUES (?,?,'team',?)", team, name, cnpj);
      }
      for (const member of members) await run(db, 'INSERT INTO members VALUES (?,?)', team, member);
    });
    res.status(id ? 200 : 201).json({ ok: true });
  });
  api.post('/admin/:collection/:id/delete', async (req, res) => {
    manager(req);
    const { collection, id } = req.params;
    check(collection === 'students' || collection === 'teams', 'Cadastro não encontrado.', 404);
    const role = collection === 'students' ? 'student' : 'team';
    await transaction(db, async db => {
      const account = await get(db, 'SELECT deleted_at FROM accounts WHERE id=? AND role=?', id, role);
      check(account, 'Cadastro não encontrado.', 404);
      if (account.deleted_at !== null) return;
      await run(db, "UPDATE operations SET status='cancelled' WHERE owner=? AND status='pending'", id);
      if (role === 'student') {
        const membership = await get(db, 'SELECT team FROM members WHERE student=?', id);
        await run(db, 'DELETE FROM members WHERE student=?', id);
        if (membership && !await get(db, 'SELECT 1 FROM members WHERE team=?', membership.team)) {
          await run(db, "UPDATE operations SET status='cancelled' WHERE owner=? AND kind='sale' AND status='pending'", membership.team);
        }
      } else {
        await run(db, 'DELETE FROM members WHERE team=?', id);
        await run(db, "UPDATE operations SET status='cancelled' WHERE status='pending' AND device IN (SELECT id FROM devices WHERE team=?)", id);
        await run(db, 'UPDATE devices SET team=NULL,pairing=NULL WHERE team=?', id);
      }
      await run(db, 'DELETE FROM sessions WHERE account=?', id);
      await run(db, 'UPDATE accounts SET deleted_at=?,username=NULL,password=NULL,cnpj=NULL,card=NULL WHERE id=?', Date.now(), id);
    });
    res.json({ ok: true });
  });
  api.post('/admin/credit', async (req, res) => {
    manager(req);
    const { account, request } = req.body;
    check(typeof account === 'string' && await get(db, "SELECT 1 FROM accounts WHERE id=? AND role IN ('student','team') AND deleted_at IS NULL", account),
      'Selecione um aluno ou um estabelecimento.');
    check(typeof request === 'string' && /^[a-f0-9]{32}$/.test(request), 'Solicitação inválida.');
    const cents = amount(req.body.amount);
    await transaction(db, db => transfer(db, { payee: account, amount: cents, method: 'credit', actor: req.user.id, request }));
    res.json({ ok: true });
  });
  api.post('/admin/devices', async (req, res) => {
    manager(req);
    const name = normalize(req.body.name);
    check(name.length >= 2 && name.length <= 50, 'Informe um nome para a maquininha.');
    const id = uid(), key = secret(), pairing = secret().slice(0, 12).toUpperCase();
    await run(db, 'INSERT INTO devices (id,name,key,pairing) VALUES (?,?,?,?)', id, name, key, hash(pairing));
    res.status(201).json({ id, key, pairing });
  });
  api.post('/admin/devices/:id/reset', async (req, res) => {
    manager(req);
    const pairing = secret().slice(0, 12).toUpperCase();
    await transaction(db, async db => {
      check(await get(db, 'SELECT 1 FROM devices WHERE id=?', req.params.id), 'Maquininha não encontrada.', 404);
      await run(db, "UPDATE operations SET status='cancelled' WHERE device=? AND status='pending'", req.params.id);
      await run(db, 'UPDATE devices SET team=NULL,pairing=? WHERE id=?', hash(pairing), req.params.id);
    });
    res.json({ pairing });
  });
  api.post('/admin/students/:id/unlink', async (req, res) => {
    manager(req);
    await transaction(db, async db => {
      await run(db, "UPDATE operations SET status='cancelled' WHERE owner=? AND kind='card' AND status='pending'", req.params.id);
      await run(db, "UPDATE accounts SET card=NULL WHERE id=? AND role='student'", req.params.id);
    });
    res.json({ ok: true });
  });
  api.post('/teams/:team/device', async (req, res) => {
    const team = req.params.team;
    const pairing = normalize(req.body.pairing).toUpperCase();
    check(/^[A-F0-9]{12}$/.test(pairing), 'Informe o código de vínculo de 12 caracteres.');
    await transaction(db, async db => {
      await teamAccess(db, req, team);
      check(!await get(db, 'SELECT 1 FROM devices WHERE team=?', team), 'O estabelecimento já tem uma maquininha.', 409);
      const result = await run(db, 'UPDATE devices SET team=?,pairing=NULL WHERE pairing=? AND team IS NULL', team, hash(pairing));
      check(result.changes, 'Código de vínculo inválido ou já usado.', 404);
    });
    res.json({ ok: true });
  });

  async function reserve(db, deviceId) {
    check(mqtt.ready(), 'MQTT indisponível. Verifique a conexão da maquininha.');
    const device = await get(db, 'SELECT * FROM devices WHERE id=? AND team IS NOT NULL', deviceId);
    check(device && device.seen >= lastMinute(), 'A maquininha está offline.');
    check(!await get(db, "SELECT 1 FROM operations WHERE device=? AND status='pending'", device.id), 'Maquininha ocupada.', 409);
    return device.id;
  }
  async function startOperation(db, { kind, owner, device, method, cents = 0, minutes }) {
    const id = uid();
    await run(db, 'INSERT INTO operations (id,kind,owner,device,method,amount,created,expires) VALUES (?,?,?,?,?,?,?,?)',
      id, kind, owner, device, method, cents, Date.now(), deadline(minutes));
    return operation(db, id);
  }
  api.post('/card', async (req, res) => {
    student(req);
    check(typeof req.body.device === 'string', 'Escolha uma maquininha.');
    const op = await transaction(db, async db => {
      await expire(db);
      check(await get(db, 'SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL', req.user.id),
        'Entre na sua conta para continuar.', 401);
      check(!await get(db, "SELECT 1 FROM operations WHERE owner=? AND kind='card' AND status='pending'", req.user.id),
        'Você já tem um vínculo em andamento.', 409);
      return startOperation(db, { kind: 'card', owner: req.user.id, device: await reserve(db, req.body.device), method: 'rfid', minutes: 1 });
    });
    await mqtt.arm(op);
    res.status(201).json(op);
  });
  api.post('/card/:id/cancel', async (req, res) => {
    student(req);
    await run(db, "UPDATE operations SET status='cancelled' WHERE id=? AND owner=? AND kind='card' AND status='pending'", req.params.id, req.user.id);
    res.json({ ok: true });
  });
  api.post('/teams/:team/sales', async (req, res) => {
    const team = req.params.team;
    const cents = amount(req.body.amount);
    const method = req.body.method;
    check(method === 'rfid' || method === 'pix', 'Escolha cartão ou Pix.');
    const op = await transaction(db, async db => {
      await teamAccess(db, req, team);
      await expire(db);
      check(!await get(db, "SELECT 1 FROM operations WHERE owner=? AND kind='sale' AND status='pending'", team),
        'Conclua ou cancele a cobrança em aberto.', 409);
      const device = method === 'rfid' ? await reserve(db, (await get(db, 'SELECT id FROM devices WHERE team=?', team))?.id || '') : null;
      return startOperation(db, { kind: 'sale', owner: team, device, method, cents, minutes: 5 });
    });
    if (op.device) await mqtt.arm(op);
    res.status(201).json(op);
  });
  api.post('/teams/:team/sales/:id/:action', async (req, res) => {
    const { team, id, action } = req.params;
    check(action === 'pix' || action === 'cancel', 'Ação inválida.', 404);
    await transaction(db, async db => {
      await teamAccess(db, req, team);
      await expire(db);
      const op = await operation(db, id);
      check(op?.owner === team && op.kind === 'sale' && op.status === 'pending', 'A cobrança já foi encerrada.', 409);
      if (action === 'pix' && op.method === 'rfid') {
        await run(db, "UPDATE operations SET method='pix', device=NULL, detail=NULL, expires=? WHERE id=?", deadline(5), id);
      }
      if (action === 'cancel') await run(db, "UPDATE operations SET status='cancelled' WHERE id=?", id);
    });
    res.json({ ok: true });
  });
  api.get('/teams/:team/sales/:id/qr', async (req, res) => {
    await teamAccess(db, req, req.params.team);
    await expire(db);
    const op = await operation(db, req.params.id);
    check(op?.owner === req.params.team && op.kind === 'sale' && op.method === 'pix' && op.status === 'pending',
      'QR Code indisponível.', 404);
    res.type('png').send(await QRCode.toBuffer('BANCOVIRTUAL:' + op.id, { width: 264, margin: 3 }));
  });

  async function pixPayer(db, req) {
    const payer = req.body.source ?? req.user.id;
    check(typeof payer === 'string', 'Conta de origem inválida.');
    if (payer !== req.user.id) await teamAccess(db, req, payer);
    return payer;
  }
  api.get('/pix/recipient/:type/:key', async (req, res) => {
    const { type, key } = req.params;
    check(type === 'username' || type === 'cnpj', 'Tipo de chave inválido.');
    const username = key.trim().toLowerCase();
    const cnpj = key.toUpperCase().replace(/[./\s-]/g, '');
    check(type === 'username' ? login.test(username) : /^[A-Z0-9]{12}\d{2}$/.test(cnpj), 'Informe um usuário ou CNPJ válido.');
    const recipient = type === 'username'
      ? await get(db, "SELECT id,name,role,username FROM accounts WHERE username=? AND role IN ('student','admin') AND deleted_at IS NULL", username)
      : await get(db, "SELECT id,name,role,cnpj FROM accounts WHERE cnpj=? AND role='team' AND deleted_at IS NULL", cnpj);
    check(recipient, 'Conta de destino não encontrada.', 404);
    res.json(recipient);
  });
  api.post('/pix/transfer', async (req, res) => {
    const { recipient, request } = req.body;
    const cents = amount(req.body.amount);
    check(typeof recipient === 'string', 'Selecione uma conta de destino.');
    check(typeof request === 'string' && /^[a-f0-9]{32}$/.test(request), 'Solicitação inválida.');
    const key = 'pix:' + req.user.id + ':' + request;
    await transaction(db, async db => {
      const payer = await pixPayer(db, req);
      check(payer !== recipient, 'Escolha uma conta diferente da conta de origem.');
      const previous = await get(db, 'SELECT payer,payee,amount FROM ledger WHERE request=?', key);
      if (previous) {
        check(previous.payer === payer && previous.payee === recipient && previous.amount === cents,
          'Este Pix já foi confirmado com outros dados.', 409);
        return;
      }
      check(await get(db, 'SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL', recipient),
        'Conta de destino não encontrada.', 404);
      await transfer(db, { payer, payee: recipient, amount: cents, method: 'pix', actor: req.user.id, request: key });
    });
    res.json({ ok: true });
  });
  async function pix(db, req) {
    const op = await operation(db, req.params.id);
    check(op?.kind === 'sale' && op.method === 'pix', 'Cobrança Pix não encontrada.', 404);
    return op;
  }
  api.get('/pix/:id', async (req, res) => {
    await expire(db);
    const op = await pix(db, req);
    check(op.status === 'pending', 'Esta cobrança foi encerrada.', 409);
    res.json({ id: op.id, amount: op.amount, name: (await get(db, 'SELECT name FROM accounts WHERE id=?', op.owner)).name });
  });
  api.post('/pix/:id', async (req, res) => {
    await transaction(db, async db => {
      const payer = await pixPayer(db, req);
      await expire(db);
      const op = await pix(db, req);
      check(payer !== op.owner, 'Escolha uma conta diferente da conta de destino.');
      const previous = await get(db, 'SELECT payer FROM ledger WHERE id=?', op.id);
      if (previous?.payer === payer) return;
      await settle(db, op, payer, 'pix', req.user.id);
    });
    res.json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use(express.static(web, { maxAge: 0 }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof Rule) return res.status(error.status).json({ error: error.message });
    if (error.status === 400 || error.status === 413) return res.status(error.status).json({ error: 'Dados inválidos.' });
    console.error(error);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  });
  return { app, close: () => {
    clearInterval(tick);
    for (const res of streams.keys()) res.end();
    mqtt.close();
  } };
}
