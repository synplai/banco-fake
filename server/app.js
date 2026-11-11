import express from 'express';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import {
  activity, all, deadline, expire, get, hash, initAdmin, moneyLimit, passwordHash,
  requireRule as check, Rule, run, secret, settle, terminalFeeRate, transaction, transfer, uid, verifyPassword
} from './db.js';
import { bridge, deviceOnlineSince } from './mqtt.js';
import { keyCandidates, normalizeKey, registeredTypes } from './pix-keys.js';
import { establishmentDre } from './dre.js';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const scanner = fileURLToPath(new URL('../node_modules/jsqr/dist/jsQR.js', import.meta.url));
const login = /^[a-z0-9._-]{3,40}$/;
const normalize = value => typeof value === 'string' ? value.trim() : '';
const userFields = 'id,name,role,username,cnpj,balance,CAST(card IS NOT NULL AS INTEGER) AS "hasCard"';
const deviceFields = 'd.id,d.name,d.team,d.seen,a.name AS "teamName",a.role AS "ownerRole"';
const publicDevice = d => ({ ...d, online: d.seen >= deviceOnlineSince() });
const defaultDeviceName = id => 'Maquininha ' + id;

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
  const mqtt = await bridge(db, config, changed);
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
  async function availableDevices() {
    if (!mqtt.ready()) return [];
    const since = deviceOnlineSince();
    const registered = await devices('WHERE d.team IS NULL AND d.seen>=?', since);
    const discovered = await all(db, `SELECT candidate.id FROM device_discovery candidate
      WHERE candidate.seen>=? AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id=candidate.id)
      GROUP BY candidate.id HAVING COUNT(*)=1 ORDER BY candidate.id`, since);
    return [...registered, ...discovered.map(({ id }) => ({ id, name: defaultDeviceName(id), online: true, discovered: true }))];
  }
  const operation = (db, id) => get(db, 'SELECT * FROM operations WHERE id=?', id);
  const chargeFields = 'c.id,c.team,c.description,c.rate,c.amount,c.created,c.paid_at,c.cancelled_at,a.name AS "teamName"';

  api.get('/admin/dre', async (req, res) => {
    manager(req);
    res.json(await establishmentDre(db, req.query));
  });

  api.get('/home', async (req, res) => {
    await expire(db);
    const user = req.user;
    if (user.role === 'admin') {
      const accounts = await all(db, "SELECT " + userFields + " FROM accounts WHERE role<>'admin' AND deleted_at IS NULL ORDER BY name");
      const members = await all(db, 'SELECT team,student FROM members');
      return res.json({ user, accounts, members, devices: await devices(), availableDevices: await availableDevices(), mqtt: mqtt.ready(),
        terminalFeeRate: await terminalFeeRate(db),
        cardEnrollment: await get(db, `SELECT id,owner,status,detail FROM operations
          WHERE actor=? AND kind='card' ORDER BY (status='pending') DESC,created DESC,id DESC LIMIT 1`, user.id) || null,
        chargeTemplates: await all(db, `SELECT id,scope AS team,description,type,value FROM bank_charge_templates
          WHERE issuer=? AND deleted_at IS NULL ORDER BY description,id`, user.id),
        charges: await all(db, 'SELECT ' + chargeFields + ' FROM bank_charges c JOIN accounts a ON a.id=c.team WHERE c.deleted_at IS NULL ORDER BY (c.amount>0 AND c.paid_at IS NULL AND c.cancelled_at IS NULL) DESC,c.created DESC LIMIT 100'),
        activity: await all(db,
        `SELECT l.id,l.amount,l.method,l.created,p.name AS "fromName",r.name AS "toName"
         FROM ledger l LEFT JOIN accounts p ON p.id=l.payer JOIN accounts r ON r.id=l.payee
         WHERE l.archived_at IS NULL ORDER BY l.created DESC LIMIT 40`) });
    }
    const teams = await all(db, 'SELECT a.id,a.name,a.cnpj,a.balance FROM accounts a JOIN members m ON a.id=m.team WHERE m.student=?', user.id);
    for (const team of teams) {
      team.activity = await activity(db, team.id);
      team.device = (await devices('WHERE d.team=?', team.id))[0] || null;
      team.sale = await get(db, "SELECT * FROM operations WHERE owner=? AND kind='sale' ORDER BY (status='pending') DESC,created DESC,id DESC LIMIT 1", team.id) || null;
      team.charges = await all(db, 'SELECT ' + chargeFields + ' FROM bank_charges c JOIN accounts a ON a.id=c.team WHERE c.team=? AND c.paid_at IS NULL AND c.cancelled_at IS NULL AND c.deleted_at IS NULL ORDER BY (c.amount>0) DESC,c.created DESC', team.id);
    }
    res.json({ user, teams, activity: await activity(db, user.id), devices: await devices(), availableDevices: teams.length ? await availableDevices() : [],
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
        await applyGlobalCharges(db, team);
      }
      for (const member of members) await run(db, 'INSERT INTO members VALUES (?,?)', team, member);
    });
    res.status(id ? 200 : 201).json({ ok: true });
  });
  api.post('/admin/devices/:id/delete', async (req, res) => {
    manager(req);
    const { id } = req.params;
    await transaction(db, async db => {
      check(await get(db, 'SELECT 1 FROM devices WHERE id=?', id), 'Maquininha não encontrada.', 404);
      await run(db, `UPDATE operations SET device=NULL,
        status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END
        WHERE device=?`, id);
      await run(db, 'DELETE FROM devices WHERE id=?', id);
    });
    res.json({ ok: true });
  });
  function deletableRole(collection) {
    check(collection === 'students' || collection === 'teams', 'Cadastro não encontrado.', 404);
    return collection === 'students' ? 'student' : 'team';
  }
  async function deleteAccount(db, id, role) {
    await run(db, "UPDATE operations SET status='cancelled' WHERE owner=? AND status='pending'", id);
    if (role === 'student') {
      const membership = await get(db, 'SELECT team FROM members WHERE student=?', id);
      await run(db, 'DELETE FROM members WHERE student=?', id);
      if (membership && !await get(db, 'SELECT 1 FROM members WHERE team=?', membership.team)) {
        await run(db, "UPDATE operations SET status='cancelled' WHERE owner=? AND kind='sale' AND status='pending'", membership.team);
      }
    } else {
      await run(db, 'DELETE FROM members WHERE team=?', id);
      await run(db, 'UPDATE bank_charges SET cancelled_at=? WHERE team=? AND paid_at IS NULL AND cancelled_at IS NULL', Date.now(), id);
      await run(db, "UPDATE operations SET status='cancelled' WHERE status='pending' AND device IN (SELECT id FROM devices WHERE team=?)", id);
      await run(db, 'UPDATE devices SET team=NULL,pairing=NULL WHERE team=?', id);
    }
    await run(db, 'DELETE FROM sessions WHERE account=?', id);
    await run(db, 'DELETE FROM pix_keys WHERE account=?', id);
    await run(db, 'UPDATE accounts SET deleted_at=?,username=NULL,password=NULL,cnpj=NULL,card=NULL WHERE id=?', Date.now(), id);
  }
  api.post('/admin/:collection/:id/delete', async (req, res) => {
    manager(req);
    const { id, collection } = req.params;
    const role = deletableRole(collection);
    await transaction(db, async db => {
      const account = await get(db, 'SELECT deleted_at FROM accounts WHERE id=? AND role=?', id, role);
      check(account, 'Cadastro não encontrado.', 404);
      if (account.deleted_at === null) await deleteAccount(db, id, role);
    });
    res.json({ ok: true });
  });
  api.post('/admin/:collection/delete-all', async (req, res) => {
    manager(req);
    const role = deletableRole(req.params.collection);
    const count = await transaction(db, async db => {
      const accounts = await all(db, 'SELECT id FROM accounts WHERE role=? AND deleted_at IS NULL', role);
      for (const account of accounts) await deleteAccount(db, account.id, role);
      return accounts.length;
    });
    res.json({ ok: true, count });
  });
  const resetBalances = db => run(db, 'UPDATE accounts SET balance=0 WHERE deleted_at IS NULL AND balance>0');
  api.post('/admin/balances/reset', async (req, res) => {
    manager(req);
    const { changes } = await resetBalances(db);
    res.json({ ok: true, count: Number(changes) });
  });
  api.post('/admin/history/reset', async (req, res) => {
    manager(req);
    await transaction(db, async db => {
      await resetBalances(db);
      await run(db, 'UPDATE ledger SET archived_at=? WHERE archived_at IS NULL', Date.now());
    });
    res.json({ ok: true });
  });
  api.post('/admin/credit', async (req, res) => {
    manager(req);
    const { account, request } = req.body;
    check(typeof account === 'string' && account.length, 'Selecione uma conta ou todas as contas.');
    check(typeof request === 'string' && /^[a-f0-9]{32}$/.test(request), 'Solicitação inválida.');
    const cents = amount(req.body.amount);
    const count = await transaction(db, async db => {
      const batch = await get(db, 'SELECT amount,recipients FROM credit_batches WHERE request=?', request);
      if (batch) {
        check(account === 'all' && batch.amount === cents, 'Este crédito já foi confirmado com outros dados.', 409);
        return batch.recipients;
      }
      const previous = await get(db, 'SELECT payee,amount FROM ledger WHERE request=?', request);
      if (previous) {
        check(previous.payee === account && previous.amount === cents, 'Este crédito já foi confirmado com outros dados.', 409);
        return 1;
      }
      const active = "SELECT id FROM accounts WHERE role IN ('student','team') AND deleted_at IS NULL";
      const targets = account === 'all' ? await all(db, active) : await all(db, active + ' AND id=?', account);
      check(targets.length, 'Nenhuma conta ativa selecionada.', 404);
      for (const target of targets) {
        await transfer(db, { payee: target.id, amount: cents, method: 'credit', actor: req.user.id,
          request: account === 'all' ? null : request });
      }
      if (account === 'all') await run(db, 'INSERT INTO credit_batches VALUES (?,?,?)', request, cents, targets.length);
      return targets.length;
    });
    res.json({ ok: true, count });
  });
  api.post('/bank/terminal-fee', async (req, res) => {
    manager(req);
    const { rate } = req.body;
    check(Number.isInteger(rate) && rate >= 0 && rate <= 10000, 'Informe um percentual entre 0% e 100%.');
    await run(db, 'INSERT INTO terminal_fee_config (id,rate) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET rate=excluded.rate', rate);
    res.json({ ok: true });
  });
  function chargeInput(body) {
    const { team, type, value } = body;
    const description = normalize(body.description);
    check(typeof team === 'string' && team.length && description.length >= 2 && description.length <= 80,
      'Informe o estabelecimento e o nome da cobrança.');
    check(type === 'fixed' || type === 'percent', 'Escolha valor fixo ou percentual.');
    if (type === 'fixed') amount(value);
    else check(Number.isInteger(value) && value > 0 && value <= 10000, 'Informe um percentual entre 0,01% e 100%.');
    return { team, type, value, description };
  }
  const validChargeRequest = request => check(typeof request === 'string' && /^[a-f0-9]{32}$/.test(request), 'Solicitação inválida.');
  const previousLaunch = (db, request, issuer) => get(db,
    'SELECT scope,description,type,value,template_id,recipient_count FROM bank_charge_launches WHERE request=? AND issuer=?', request, issuer);
  async function addChargeRecipient(db, launch, { id, balance }) {
    const rate = launch.type === 'percent' ? launch.value : null;
    const cents = rate === null ? launch.value : Math.round(balance * rate / 10000);
    await run(db, `INSERT INTO bank_charges (id,request,scope,issuer,team,description,rate,amount,created,template_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, uid(), launch.request, launch.scope, launch.issuer, id, launch.description,
    rate, cents, launch.created, launch.template_id);
  }
  async function applyGlobalCharges(db, team) {
    const launches = await all(db, `SELECT l.* FROM bank_charge_launches l
      LEFT JOIN bank_charge_templates t ON t.id=l.template_id
      WHERE l.scope='all' AND t.deleted_at IS NULL AND
        (NOT EXISTS (SELECT 1 FROM bank_charges c WHERE c.request=l.request AND c.issuer=l.issuer) OR
         EXISTS (SELECT 1 FROM bank_charges c WHERE c.request=l.request AND c.issuer=l.issuer
          AND c.deleted_at IS NULL AND c.cancelled_at IS NULL))`);
    for (const launch of launches) await addChargeRecipient(db, launch, { id: team, balance: 0 });
  }
  async function issueCharges(db, { team, type, value, description }, issuer, request, templateId = null) {
    const active = "SELECT id,balance FROM accounts WHERE role='team' AND deleted_at IS NULL";
    const targets = team === 'all' ? await all(db, active) : await all(db, active + ' AND id=?', team);
    check(team === 'all' || targets.length, 'Nenhum estabelecimento ativo selecionado.', 404);
    const launch = { issuer, request, scope: team, description, type, value, created: Date.now(), template_id: templateId };
    await run(db, `INSERT INTO bank_charge_launches (issuer,request,scope,description,type,value,created,template_id,recipient_count)
      VALUES (?,?,?,?,?,?,?,?,?)`, issuer, request, team, description, type, value, launch.created, templateId, targets.length);
    for (const target of targets) await addChargeRecipient(db, launch, target);
    return targets.length;
  }
  api.post('/bank/charges', async (req, res) => {
    manager(req);
    const charge = chargeInput(req.body);
    const { request } = req.body;
    validChargeRequest(request);
    const count = await transaction(db, async db => {
      const saved = await previousLaunch(db, request, req.user.id);
      if (saved) {
        check(saved.template_id === null && saved.scope === charge.team && saved.description === charge.description &&
          saved.type === charge.type && saved.value === charge.value,
          'Este lançamento já foi confirmado com outros dados.', 409);
        return saved.recipient_count;
      }
      return issueCharges(db, charge, req.user.id, request);
    });
    res.status(201).json({ ok: true, count });
  });
  api.post(['/bank/charge-templates', '/bank/charge-templates/:id/edit'], async (req, res) => {
    manager(req);
    const { team, type, value, description } = chargeInput(req.body);
    const { id } = req.params;
    const template = id || uid();
    await transaction(db, async db => {
      check(team === 'all' || await get(db, "SELECT 1 FROM accounts WHERE id=? AND role='team' AND deleted_at IS NULL", team),
        'Estabelecimento não encontrado.', 404);
      if (id) {
        const result = await run(db, `UPDATE bank_charge_templates SET scope=?,description=?,type=?,value=?
          WHERE id=? AND issuer=? AND deleted_at IS NULL`, team, description, type, value, id, req.user.id);
        check(result.changes, 'Cobrança salva não encontrada.', 404);
      } else {
        await run(db, 'INSERT INTO bank_charge_templates (id,issuer,scope,description,type,value) VALUES (?,?,?,?,?,?)',
          template, req.user.id, team, description, type, value);
      }
    });
    res.status(id ? 200 : 201).json({ ok: true, id: template });
  });
  api.post('/bank/charge-templates/:id/launch', async (req, res) => {
    manager(req);
    const { request } = req.body;
    const { id } = req.params;
    validChargeRequest(request);
    const count = await transaction(db, async db => {
      const saved = await previousLaunch(db, request, req.user.id);
      if (saved) {
        check(saved.template_id === id, 'Este lançamento já foi confirmado com outros dados.', 409);
        return saved.recipient_count;
      }
      const template = await get(db, `SELECT scope AS team,description,type,value FROM bank_charge_templates
        WHERE id=? AND issuer=? AND deleted_at IS NULL`, id, req.user.id);
      check(template, 'Cobrança salva não encontrada.', 404);
      return issueCharges(db, template, req.user.id, request, id);
    });
    res.status(201).json({ ok: true, count });
  });
  api.post('/bank/charge-templates/:id/delete', async (req, res) => {
    manager(req);
    const result = await run(db, 'UPDATE bank_charge_templates SET deleted_at=? WHERE id=? AND issuer=? AND deleted_at IS NULL',
      Date.now(), req.params.id, req.user.id);
    check(result.changes, 'Cobrança salva não encontrada.', 404);
    res.json({ ok: true });
  });
  api.post('/bank/charges/:id/pay', async (req, res) => {
    const id = req.params.id;
    await transaction(db, async db => {
      const charge = await get(db, 'SELECT * FROM bank_charges WHERE id=?', id);
      check(charge, 'Cobrança não encontrada.', 404);
      await teamAccess(db, req, charge.team);
      check(!charge.cancelled_at, 'Esta cobrança foi cancelada.', 409);
      if (charge.paid_at || charge.amount === 0) return;
      await transfer(db, { id, payer: charge.team, payee: charge.issuer, amount: charge.amount, method: 'fee', actor: req.user.id });
      await run(db, 'UPDATE bank_charges SET paid_at=? WHERE id=?', Date.now(), id);
    });
    res.json({ ok: true, id });
  });
  api.post('/bank/charges/:id/cancel', async (req, res) => {
    manager(req);
    const result = await run(db, 'UPDATE bank_charges SET cancelled_at=? WHERE id=? AND issuer=? AND paid_at IS NULL AND cancelled_at IS NULL',
      Date.now(), req.params.id, req.user.id);
    check(result.changes, 'Esta cobrança já foi encerrada.', 409);
    res.json({ ok: true });
  });
  api.post('/bank/charges/:id/delete', async (req, res) => {
    manager(req);
    const now = Date.now();
    const result = await run(db, `UPDATE bank_charges SET deleted_at=?,
      cancelled_at=CASE WHEN paid_at IS NULL THEN COALESCE(cancelled_at,?) ELSE cancelled_at END
      WHERE id=? AND issuer=? AND deleted_at IS NULL`, now, now, req.params.id, req.user.id);
    check(result.changes, 'Cobrança emitida não encontrada.', 404);
    res.json({ ok: true });
  });
  api.post('/admin/devices', async (req, res) => {
    manager(req);
    if (typeof req.body.deviceId === 'string' && req.body.deviceKey === undefined && req.body.name === undefined) {
      const id = normalize(req.body.deviceId);
      check(/^\d{4}$/.test(id), 'Informe os quatro dígitos da maquininha.');
      await transaction(db, async db => {
        check(!await get(db, 'SELECT 1 FROM devices WHERE id=?', id), 'Esta maquininha já está cadastrada.', 409);
        await registerDiscoveredDevice(db, id);
      });
      return res.status(201).json({ id });
    }
    const name = normalize(req.body.name);
    check(name.length >= 2 && name.length <= 50, 'Informe um nome para a maquininha.');
    const providedId = normalize(req.body.deviceId).toLowerCase();
    const providedKey = normalize(req.body.deviceKey).toLowerCase();
    if (req.body.deviceId !== undefined || req.body.deviceKey !== undefined) {
      check(/^(?:[0-9]{4}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(providedId) &&
        /^[a-f0-9]{64}$/.test(providedKey), 'Informe o ID e a chave exibidos na maquininha.');
    }
    const id = providedId || uid(), key = providedKey || secret(), pairing = secret().slice(0, 12).toUpperCase();
    await transaction(db, async db => {
      check(!await get(db, 'SELECT 1 FROM devices WHERE id=?', id), 'Este ID já está cadastrado. Confira a lista de maquininhas.', 409);
      await run(db, 'INSERT INTO devices (id,name,key,pairing) VALUES (?,?,?,?)', id, name, key, hash(pairing));
    });
    res.status(201).json({ id, key, pairing });
  });
  async function registerDiscoveredDevice(db, id) {
    check(/^\d{4}$/.test(id), 'Maquininha não encontrada.', 404);
    const candidates = mqtt.ready() ? await all(db,
      'SELECT key,seen FROM device_discovery WHERE id=? AND seen>=?', id, deviceOnlineSince()) : [];
    check(candidates.length, 'Maquininha offline. Ligue-a e confira os quatro dígitos.', 404);
    check(candidates.length === 1, 'Há duas maquininhas com esse ID. Gere outro ID no portal de uma delas.', 409);
    const { key, seen } = candidates[0];
    await run(db, 'INSERT INTO devices (id,name,key,seen) VALUES (?,?,?,?)', id, defaultDeviceName(id), key, seen);
    await run(db, 'DELETE FROM device_discovery WHERE id=?', id);
  }
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
  async function linkDevice(db, owner, id, bank = null) {
    check(typeof owner === 'string' && typeof id === 'string', 'Selecione a conta e a maquininha.');
    check(await get(db, "SELECT 1 FROM accounts WHERE id=? AND (role='team' OR (role='admin' AND id=?)) AND deleted_at IS NULL", owner, bank),
      'Conta não encontrada.', 404);
    const device = await get(db, 'SELECT team FROM devices WHERE id=?', id);
    if (device?.team === owner) return;
    check(!device?.team, 'Esta maquininha já está vinculada a outra conta.', 409);
    if (!device) await registerDiscoveredDevice(db, id);
    check(!await get(db, 'SELECT 1 FROM devices WHERE team=?', owner), 'Esta conta já tem uma maquininha.', 409);
    await run(db, 'UPDATE devices SET team=?,pairing=NULL WHERE id=?', owner, id);
  }
  api.post('/admin/devices/:id/link', async (req, res) => {
    manager(req);
    await transaction(db, db => linkDevice(db, req.body.team, req.params.id, req.user.id));
    res.json({ ok: true });
  });
  api.post('/admin/devices/:id/unlink', async (req, res) => {
    manager(req);
    await transaction(db, async db => {
      check(await get(db, 'SELECT 1 FROM devices WHERE id=?', req.params.id), 'Maquininha não encontrada.', 404);
      await run(db, "UPDATE operations SET status='cancelled' WHERE device=? AND status='pending'", req.params.id);
      await run(db, 'UPDATE devices SET team=NULL,pairing=NULL WHERE id=?', req.params.id);
    });
    res.json({ ok: true });
  });
  api.post('/admin/devices/:id/edit', async (req, res) => {
    manager(req);
    const name = normalize(req.body.name);
    check(name.length >= 2 && name.length <= 50, 'Informe um nome de 2 a 50 caracteres.');
    const result = await run(db, 'UPDATE devices SET name=? WHERE id=?', name, req.params.id);
    check(result.changes, 'Maquininha não encontrada.', 404);
    res.json({ ok: true });
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
    await transaction(db, async db => {
      await teamAccess(db, req, team);
      let id = req.body.device;
      if (id === undefined) {
        check(/^[A-F0-9]{12}$/.test(pairing), 'Selecione uma maquininha disponível.');
        id = (await get(db, 'SELECT id FROM devices WHERE pairing=? AND team IS NULL', hash(pairing)))?.id;
        check(id, 'Código de vínculo inválido ou já usado.', 404);
      }
      await linkDevice(db, team, id);
    });
    res.json({ ok: true });
  });

  async function reserve(db, deviceId, ownerRole = 'team') {
    check(mqtt.ready(), 'MQTT indisponível. Verifique a conexão da maquininha.');
    const device = await get(db, 'SELECT d.id,d.seen FROM devices d JOIN accounts a ON a.id=d.team WHERE d.id=? AND a.role=?', deviceId, ownerRole);
    check(device && device.seen >= deviceOnlineSince(), 'A maquininha está offline.');
    check(!await get(db, "SELECT 1 FROM operations WHERE device=? AND status='pending'", device.id), 'Maquininha ocupada.', 409);
    return device.id;
  }
  async function startOperation(db, { kind, owner, device, method, cents = 0, minutes, actor = null }) {
    const id = uid();
    await run(db, 'INSERT INTO operations (id,kind,owner,device,method,amount,created,expires,actor) VALUES (?,?,?,?,?,?,?,?,?)',
      id, kind, owner, device, method, cents, Date.now(), deadline(minutes), actor);
    return operation(db, id);
  }
  async function startCardEnrollment(db, owner, deviceId, actor = null) {
    await expire(db);
    check(!await get(db, "SELECT 1 FROM operations WHERE owner=? AND kind='card' AND status='pending'", owner),
      'Já existe um vínculo de cartão em andamento para este aluno.', 409);
    const device = await reserve(db, deviceId, actor ? 'admin' : 'team');
    return startOperation(db, { kind: 'card', owner, device, method: 'rfid', minutes: 1, actor });
  }
  api.post('/card', async (req, res) => {
    student(req);
    check(typeof req.body.device === 'string', 'Escolha uma maquininha.');
    const op = await transaction(db, async db => {
      check(await get(db, 'SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL', req.user.id),
        'Entre na sua conta para continuar.', 401);
      return startCardEnrollment(db, req.user.id, req.body.device);
    });
    await mqtt.arm(op);
    res.status(201).json(op);
  });
  api.post('/admin/students/:id/card', async (req, res) => {
    manager(req);
    const op = await transaction(db, async db => {
      const owner = req.params.id;
      check(await get(db, "SELECT 1 FROM accounts WHERE id=? AND role='student' AND deleted_at IS NULL", owner), 'Aluno não encontrado.', 404);
      const device = await get(db, 'SELECT id FROM devices WHERE team=?', req.user.id);
      check(device, 'Vincule a maquininha à conta do banco primeiro.', 409);
      return startCardEnrollment(db, owner, device.id, req.user.id);
    });
    await mqtt.arm(op);
    res.status(201).json(op);
  });
  api.post('/card/:id/cancel', async (req, res) => {
    if (req.user.role !== 'admin') student(req);
    const accountField = req.user.role === 'admin' ? 'actor' : 'owner';
    await run(db, `UPDATE operations SET status='cancelled' WHERE id=? AND ${accountField}=? AND kind='card' AND status='pending'`, req.params.id, req.user.id);
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

  async function pixAccount(db, req, source = req.user.id) {
    check(typeof source === 'string', 'Conta de origem inválida.');
    if (source !== req.user.id) await teamAccess(db, req, source);
    const account = await get(db, 'SELECT id,role,username,cnpj FROM accounts WHERE id=? AND deleted_at IS NULL', source);
    check(account, 'Conta indisponível.', 404);
    return account;
  }
  async function findPixRecipient(db, type, key) {
    const matches = new Map();
    for (const [kind, value] of keyCandidates(type, key)) {
      const fields = 'a.id,a.name,a.role,a.username,a.cnpj';
      let account;
      if (kind === 'username') {
        account = await get(db, 'SELECT ' + fields + ' FROM accounts a WHERE a.username=? AND a.deleted_at IS NULL', value);
      } else if (kind === 'cnpj') {
        account = await get(db, 'SELECT ' + fields + ' FROM accounts a WHERE a.cnpj=? AND a.deleted_at IS NULL', value);
      } else {
        account = await get(db, 'SELECT ' + fields + ' FROM accounts a JOIN pix_keys k ON k.account=a.id WHERE k.type=? AND k.value=? AND a.deleted_at IS NULL', kind, value);
      }
      if (account) matches.set(account.id, account);
    }
    check(matches.size > 0, 'Chave Pix não encontrada.', 404);
    check(matches.size === 1, 'Chave ambígua. Use @ antes do usuário, +55 para celular ou a pontuação do CPF/CNPJ.', 409);
    return matches.values().next().value;
  }
  api.get('/pix/keys', async (req, res) => {
    const account = await pixAccount(db, req, req.query.source);
    const keys = await all(db, 'SELECT id,type,value FROM pix_keys WHERE account=? ORDER BY type,value', account.id);
    const builtin = account.cnpj ? { type: 'cnpj', value: account.cnpj } : { type: 'username', value: '@' + account.username };
    res.json({ keys: [builtin, ...keys] });
  });
  api.post('/pix/keys', async (req, res) => {
    const { type, source } = req.body;
    check(registeredTypes.includes(type), 'Escolha um tipo de chave Pix.');
    const value = type === 'random' ? uid() : normalizeKey(type, req.body.value);
    check(value, 'Informe uma chave válida para o tipo selecionado.');
    await transaction(db, async db => {
      const account = await pixAccount(db, req, source);
      check(type !== 'cpf' || account.role !== 'team', 'Use o CNPJ do estabelecimento como chave de documento.');
      check(!await get(db, 'SELECT 1 FROM pix_keys WHERE type=? AND value=?', type, value), 'Esta chave Pix já está cadastrada.', 409);
      await run(db, 'INSERT INTO pix_keys (id,account,type,value) VALUES (?,?,?,?)', uid(), account.id, type, value);
    });
    res.status(201).json({ ok: true });
  });
  api.post('/pix/keys/:id/remove', async (req, res) => {
    await transaction(db, async db => {
      const account = await pixAccount(db, req, req.body.source);
      const result = await run(db, 'DELETE FROM pix_keys WHERE id=? AND account=?', req.params.id, account.id);
      check(result.changes, 'Chave Pix não encontrada nesta conta.', 404);
    });
    res.json({ ok: true });
  });
  api.get('/pix/recipient/:type/:key', async (req, res) => {
    res.json(await findPixRecipient(db, req.params.type, req.params.key));
  });
  api.post('/pix/transfer', async (req, res) => {
    const { recipient, request } = req.body;
    const cents = amount(req.body.amount);
    check(typeof recipient === 'string', 'Selecione uma conta de destino.');
    check(typeof request === 'string' && /^[a-f0-9]{32}$/.test(request), 'Solicitação inválida.');
    const key = 'pix:' + req.user.id + ':' + request;
    const id = await transaction(db, async db => {
      const payer = (await pixAccount(db, req, req.body.source)).id;
      check(payer !== recipient, 'Escolha uma conta diferente da conta de origem.');
      const previous = await get(db, 'SELECT id,payer,payee,amount FROM ledger WHERE request=?', key);
      if (previous) {
        check(previous.payer === payer && previous.payee === recipient && previous.amount === cents,
          'Este Pix já foi confirmado com outros dados.', 409);
        return previous.id;
      }
      if (req.body.key !== undefined) {
        const resolved = await findPixRecipient(db, 'auto', req.body.key);
        check(resolved.id === recipient, 'O destinatário mudou. Consulte a chave novamente.', 409);
      }
      const id = uid();
      await transfer(db, { id, payer, payee: recipient, amount: cents, method: 'pix', actor: req.user.id, request: key });
      return id;
    });
    res.json({ ok: true, id });
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
      const payer = (await pixAccount(db, req, req.body.source)).id;
      await expire(db);
      const op = await pix(db, req);
      check(payer !== op.owner, 'Escolha uma conta diferente da conta de destino.');
      const previous = await get(db, 'SELECT payer FROM ledger WHERE id=?', op.id);
      if (previous?.payer === payer) return;
      await settle(db, op, payer, 'pix', req.user.id);
    });
    res.json({ ok: true, id: req.params.id });
  });

  async function canOperate(db, req, account) {
    return Boolean(account && (account === req.user.id ||
      await get(db, 'SELECT 1 FROM members WHERE team=? AND student=?', account, req.user.id)));
  }
  const refundable = entry => entry.payer && (entry.method === 'pix' || entry.method === 'rfid');
  api.get('/activity/:id', async (req, res) => {
    const entry = await get(db, `SELECT l.id,l.payer,l.payee,l.amount,l.created,l.method,
      p.name AS "fromName",p.role AS "fromRole",p.username AS "fromUser",p.cnpj AS "fromCnpj",
      a.name AS "toName",a.role AS "toRole",a.username AS "toUser",a.cnpj AS "toCnpj",
      p.deleted_at AS "payerDeleted",r.reversal AS "refundId",original.original AS "originalId",c.description,
      fee.amount AS "terminalFee"
      FROM ledger l LEFT JOIN accounts p ON p.id=l.payer JOIN accounts a ON a.id=l.payee
      LEFT JOIN refunds r ON r.original=l.id LEFT JOIN refunds original ON original.reversal=l.id
      LEFT JOIN bank_charges c ON c.id=l.id
      LEFT JOIN terminal_fees tf ON tf.sale=l.id LEFT JOIN ledger fee ON fee.id=tf.charge
      WHERE l.id=?`, req.params.id);
    check(entry, 'Movimentação não encontrada.', 404);
    const receiver = await canOperate(db, req, entry.payee);
    check(receiver || req.user.role === 'admin' || await canOperate(db, req, entry.payer), 'Movimentação não encontrada.', 404);
    res.json({ ...entry, canRefund: Boolean(receiver && refundable(entry) && !entry.refundId && !entry.payerDeleted) });
  });
  api.post('/activity/:id/refund', async (req, res) => {
    const id = await transaction(db, async db => {
      const entry = await get(db, 'SELECT id,payer,payee,amount,method FROM ledger WHERE id=?', req.params.id);
      check(entry && await canOperate(db, req, entry.payee), 'Movimentação não encontrada.', 404);
      check(refundable(entry), 'Esta movimentação não pode ser devolvida.', 409);
      const previous = await get(db, 'SELECT reversal FROM refunds WHERE original=?', entry.id);
      if (previous) return previous.reversal;
      const fee = await get(db, 'SELECT l.id,l.payee,l.amount FROM terminal_fees f JOIN ledger l ON l.id=f.charge WHERE f.sale=?', entry.id);
      const returnFee = async () => {
        const reversal = uid();
        await transfer(db, { id: reversal, payer: fee.payee, payee: entry.payee, amount: fee.amount, method: 'terminal_fee_refund', actor: req.user.id });
        await run(db, 'INSERT INTO refunds (original,reversal) VALUES (?,?)', fee.id, reversal);
      };
      // If the gross refund needs the returned fee, credit it first. Otherwise pay first to leave room for the credit.
      const feeFirst = fee && (await get(db, 'SELECT balance FROM accounts WHERE id=?', entry.payee)).balance < entry.amount;
      if (feeFirst) await returnFee();
      const id = uid();
      await transfer(db, { id, payer: entry.payee, payee: entry.payer, amount: entry.amount, method: 'refund', actor: req.user.id });
      if (fee && !feeFirst) await returnFee();
      await run(db, 'INSERT INTO refunds (original,reversal) VALUES (?,?)', entry.id, id);
      return id;
    });
    res.json({ ok: true, id });
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
