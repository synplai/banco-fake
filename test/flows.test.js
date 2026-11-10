import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Aedes from 'aedes';
import mqtt from 'mqtt';
import pg from 'pg';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { signature } from '../server/mqtt.js';

async function eventually(check) {
  const stop = Date.now() + 4000;
  do {
    if (await check()) return;
    await delay(40);
  } while (Date.now() < stop);
  assert.fail('Estado esperado não observado');
}
async function setup(config, t, memberCount = 3) {
  let connectionString;
  let disposeSchema;
  let db, server, close;
  t.after(async () => {
    try {
      close?.();
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      await db?.close();
    } finally {
      await disposeSchema?.();
    }
  });
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    const schema = 'test_' + randomBytes(8).toString('hex');
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    disposeSchema = async () => {
      try { await client.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
      finally { await client.end(); }
    };
    await client.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    connectionString = url.toString();
  }
  db = await openDb(':memory:', connectionString);
  const bank = await createApp(db, { ADMIN_USER: 'gestor', ADMIN_PASSWORD: 'GestorTeste2026', ...config });
  close = bank.close;
  server = bank.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  function session() {
    let cookie = '';
    return async (path, body, status = 200, opts = {}) => {
      const response = await fetch(url + '/api' + path, {
        headers: { cookie, 'Content-Type': 'application/json' },
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
        ...opts
      });
      assert.equal(response.status, status, response.status !== status ? await response.text() : '');
      const received = response.headers.get('set-cookie');
      if (received) cookie = received.split(';')[0];
      return response.headers.get('content-type')?.includes('application/json') ? response.json() : response;
    };
  }
  const admin = session();
  await admin('/login', { username: 'gestor', password: 'GestorTeste2026' });
  const students = [];
  for (let index = 1; index <= 4; index++) {
    const username = 'aluno' + index;
    const password = 'AlunoTeste2026';
    await admin('/admin/students', { name: 'Aluno ' + index, username, password }, 201);
    const request = session();
    await request('/login', { username, password });
    const { user } = await request('/home');
    students.push({ id: user.id, request });
  }
  const establishment = { name: 'Estabelecimento teste', cnpj: '00.000.000/0001-90' };
  await admin('/admin/teams', { ...establishment, members: [] }, 400);
  await admin('/admin/teams', { ...establishment, members: [students[0].id, students[0].id] }, 400);
  const members = students.slice(0, memberCount).map(s => s.id);
  await admin('/admin/teams', { ...establishment, members }, 201);
  const team = (await students[0].request('/home')).teams[0];
  assert.deepEqual((await admin('/home')).members.filter(row => row.team === team.id).map(row => row.student).sort(), [...members].sort());
  const credit = (account, amount, request = randomBytes(16).toString('hex')) => admin('/admin/credit', { account, amount, request });
  return { admin, session, students, team, credit };
}

test('gestor edita dados e acessos sem recriar contas nem apagar movimentações', async t => {
  const { admin, students, team, credit, session } = await setup({}, t, 1);
  const [seller, replacement, , other] = students;
  const studentPath = '/admin/students/' + seller.id + '/edit';
  const teamPath = '/admin/teams/' + team.id + '/edit';
  const salePath = '/teams/' + team.id + '/sales';
  await credit(seller.id, 1200);
  await credit(team.id, 2500);
  const sale = await seller.request(salePath, { amount: 500, method: 'pix' }, 201);

  const profile = { name: 'Nome atualizado', username: 'aluno.novo' };
  await seller.request(studentPath, profile, 403);
  await admin(studentPath, { ...profile, username: 'aluno2' }, 409);
  await admin(studentPath, profile);
  const { user, activity } = await seller.request('/home');
  assert.equal(user.name, profile.name);
  assert.equal(user.username, profile.username);
  assert.equal(user.balance, 1200);
  assert.equal(activity.length, 1);
  await session()('/login', { username: profile.username, password: 'AlunoTeste2026' });

  const edited = { name: 'Oficina atualizada', cnpj: '00.000.000/0001-55', members: [replacement.id] };
  await seller.request(teamPath, edited, 403);
  await admin('/admin/teams', { name: 'Outro estabelecimento', cnpj: '00.000.000/0001-77', members: [other.id] }, 201);
  await admin(teamPath, { ...edited, cnpj: '00.000.000/0001-77' }, 409);
  await admin(teamPath, { ...edited, members: [other.id] }, 409);
  await admin(teamPath, { ...edited, members: [] }, 400);
  assert.equal((await seller.request('/home')).teams[0].id, team.id);
  await admin(teamPath, edited);
  assert.equal((await seller.request('/home')).teams.length, 0);
  await seller.request(salePath + '/' + sale.id + '/cancel', {}, 403);
  const updated = (await replacement.request('/home')).teams[0];
  assert.equal(updated.id, team.id);
  assert.equal(updated.name, edited.name);
  assert.equal(updated.cnpj, '00000000000155');
  assert.equal(updated.balance, 2500);
  assert.equal(updated.sale.id, sale.id);
  assert.equal(updated.activity.length, 1);

  await admin(studentPath, { ...profile, password: 'SenhaNova2026' });
  await seller.request('/home', undefined, 401);
  await session()('/login', { username: profile.username, password: 'AlunoTeste2026' }, 401);
  await session()('/login', { username: profile.username, password: 'SenhaNova2026' });
});

test('exclusão revoga o acesso e libera vínculos, preservando o histórico', async t => {
  const { admin, students, team, credit, session } = await setup({}, t, 1);
  const [seller, replacement, , buyer] = students;
  const studentPath = '/admin/students/' + seller.id + '/delete';
  const teamPath = '/admin/teams/' + team.id + '/delete';
  const salePath = '/teams/' + team.id + '/sales';
  const device = await admin('/admin/devices', { name: 'Terminal de teste' }, 201);
  await seller.request('/teams/' + team.id + '/device', { pairing: device.pairing });
  await credit(seller.id, 1000);
  await credit(buyer.id, 1000);
  const paid = await seller.request(salePath, { amount: 200, method: 'pix' }, 201);
  await buyer.request('/pix/' + paid.id, {});
  const pending = await seller.request(salePath, { amount: 300, method: 'pix' }, 201);
  await seller.request(studentPath, {}, 403);
  await admin(studentPath, {});
  await admin(studentPath, {});
  await seller.request('/home', undefined, 401);
  await session()('/login', { username: 'aluno1', password: 'AlunoTeste2026' }, 401);
  await buyer.request('/pix/' + pending.id, {}, 409);
  const afterStudent = await admin('/home');
  assert.ok(!afterStudent.accounts.some(account => account.id === seller.id));
  assert.ok(!afterStudent.members.some(member => member.team === team.id));
  assert.ok(afterStudent.activity.some(row => row.toName === 'Aluno 1' && row.amount === 1000));
  await admin('/admin/students', { name: 'Novo aluno', username: 'aluno1', password: 'AlunoNovo2026' }, 201);

  await admin('/admin/teams/' + team.id + '/edit', { name: team.name, cnpj: team.cnpj, members: [replacement.id] });
  const lastSale = await replacement.request(salePath, { amount: 300, method: 'pix' }, 201);
  await replacement.request(teamPath, {}, 403);
  await admin(teamPath, {});
  await admin(teamPath, {});
  await buyer.request('/pix/' + lastSale.id, {}, 409);
  assert.equal((await buyer.request('/home')).user.balance, 800);
  assert.deepEqual((await replacement.request('/home')).teams, []);
  const afterTeam = await admin('/home');
  assert.ok(!afterTeam.accounts.some(account => account.id === team.id));
  assert.equal(afterTeam.devices.find(row => row.id === device.id).team, null);
  assert.ok(afterTeam.activity.some(row => row.id === paid.id && row.toName === team.name));
  await admin('/admin/teams', { name: 'Novo estabelecimento', cnpj: team.cnpj, members: [replacement.id] }, 201);
  const newTeam = (await replacement.request('/home')).teams[0];
  assert.equal(newTeam.balance, 0);
  const { pairing } = await admin('/admin/devices/' + device.id + '/reset', {});
  await replacement.request('/teams/' + newTeam.id + '/device', { pairing });
});

test('Pix independente de MQTT, QR Code, autorização, SSE e pagamento idempotente', async t => {
  const { admin, students, team, credit, session } = await setup({}, t, 1);
  const [seller, , secondBuyer, buyer] = students;
  const salePath = '/teams/' + team.id + '/sales';
  await session()('/home', undefined, 401);
  await buyer.request(salePath, { amount: 1250, method: 'pix' }, 403);
  const creditId = randomBytes(16).toString('hex');
  await credit(buyer.id, 5000, creditId);
  await credit(buyer.id, 5000, creditId);
  await credit(team.id, 2000);
  await seller.request(salePath, { amount: 1250, method: 'rfid' }, 400);
  const sale = await seller.request(salePath, { amount: 1250, method: 'pix' }, 201);
  await seller.request(salePath, { amount: 1250, method: 'pix' }, 409);
  const qr = await seller.request(salePath + '/' + sale.id + '/qr');
  assert.equal(qr.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await qr.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
  assert.deepEqual(await buyer.request('/pix/' + sale.id), { id: sale.id, amount: 1250, name: 'Estabelecimento teste' });
  await secondBuyer.request('/pix/' + sale.id, {}, 409);

  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = await seller.request('/events', undefined, 200, { signal: abort.signal });
  const reader = events.body.getReader();
  const next = async () => Buffer.from((await reader.read()).value).toString();
  assert.match(await next(), /event: update/);
  await Promise.all([buyer.request('/pix/' + sale.id, {}), buyer.request('/pix/' + sale.id, {})]);
  const event = await Promise.race([next(), delay(2000, '')]);
  assert.match(event, /event: update/);
  abort.abort();
  assert.equal((await buyer.request('/home')).user.balance, 3750);
  assert.equal((await seller.request('/home')).teams[0].balance, 3250);
  assert.equal((await admin('/home')).activity.filter(row => row.method === 'pix').length, 1);
  await secondBuyer.request('/pix/' + sale.id, {}, 409);
});

test('Pix direto e por cobrança entre contas pessoais e estabelecimentos', async t => {
  const { admin, students, team, credit } = await setup({}, t, 1);
  const [first, second, outsider] = students;
  await admin('/admin/teams', {
    name: 'Segundo estabelecimento', cnpj: '00.000.000/0001-91', members: [second.id]
  }, 201);
  const otherTeam = (await second.request('/home')).teams[0];
  const recipient = await first.request('/pix/recipient/username/ALUNO2');
  assert.equal(recipient.id, second.id);
  assert.equal((await second.request('/pix/recipient/cnpj/' + encodeURIComponent('00.000.000/0001-90'))).id, team.id);
  const manager = await outsider.request('/pix/recipient/username/gestor');
  assert.equal(manager.role, 'admin');
  await credit(first.id, 1000);
  await credit(team.id, 2000);

  const send = (actor, source, recipient, amount, status = 200) =>
    actor.request('/pix/transfer', { source, recipient, amount, request: randomBytes(16).toString('hex') }, status);
  await send(second, team.id, second.id, 100, 403);
  await send(second, second.id, first.id, 100, 409);
  await send(first, first.id, first.id, 100, 400);
  const firstPix = { source: first.id, recipient: second.id, amount: 100, request: randomBytes(16).toString('hex') };
  await Promise.all([first.request('/pix/transfer', firstPix), first.request('/pix/transfer', firstPix)]);
  await first.request('/pix/transfer', { ...firstPix, amount: 101 }, 409);
  await send(first, first.id, team.id, 200);
  await send(first, team.id, first.id, 300);
  await send(first, team.id, otherTeam.id, 400);
  await send(second, otherTeam.id, second.id, 150);

  const sale = await first.request('/teams/' + team.id + '/sales', { amount: 100, method: 'pix' }, 201);
  await first.request('/pix/' + sale.id, { source: team.id }, 400);
  await outsider.request('/pix/' + sale.id, { source: otherTeam.id }, 403);
  await second.request('/pix/' + sale.id, { source: otherTeam.id });
  await second.request('/pix/' + sale.id, { source: otherTeam.id });
  const firstHome = await first.request('/home');
  const secondHome = await second.request('/home');
  assert.equal(firstHome.user.balance, 1000);
  assert.equal(firstHome.teams[0].balance, 1600);
  assert.equal(secondHome.user.balance, 250);
  assert.equal(secondHome.teams[0].balance, 150);
  assert.ok(secondHome.teams[0].activity.some(row => row.id === sale.id && row.payer === otherTeam.id));
  await send({ request: admin }, manager.id, first.id, 100, 409);
  await send(first, first.id, manager.id, 100);
  await send({ request: admin }, manager.id, otherTeam.id, 75);
  const managerHome = await admin('/home');
  assert.equal(managerHome.user.balance, 25);
  assert.equal(managerHome.activity.filter(row => row.method === 'pix').length, 8);
});

test('MQTT com dispositivo simulado, vínculo de RFID, cartão duplicado e conversão em Pix', async t => {
  const broker = Aedes();
  const listener = createServer(broker.handle).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = 'mqtt://127.0.0.1:' + listener.address().port;
  const { admin, students, team, credit } = await setup({ MQTT_URL: url }, t);
  const [seller, second, , buyer] = students;
  const device = await admin('/admin/devices', { name: 'RC522 de teste' }, 201);
  const client = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 3000 });
  t.after(async () => {
    client.end(true);
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => listener.close(resolve));
  });
  await once(client, 'connect');
  const base = 'bancofeira/v1/' + device.id;
  await client.subscribeAsync(base + '/arm');
  let armed;
  client.on('message', (topic, data) => { armed = JSON.parse(data.toString()); });
  const send = (type, op = '', card = '', nonce = randomBytes(16).toString('hex'), key = device.key) =>
    client.publishAsync(base + '/event', JSON.stringify({
      type, op, card, nonce, sig: signature(key, type, device.id, nonce, op, card)
    }), { qos: 1 });
  await seller.request('/teams/' + team.id + '/device', { pairing: device.pairing });
  await eventually(async () => (await admin('/home')).mqtt);
  await send('hello');
  await eventually(async () => (await admin('/home')).devices[0].online);
  assert.equal((await admin('/home')).devices[0].team, team.id);

  const card = 'AABBCCDD';
  const enrollment = await buyer.request('/card', { device: device.id }, 201);
  await eventually(() => armed?.op === enrollment.id);
  assert.equal(armed.sig, signature(device.key, 'arm', device.id, enrollment.id, armed.expires));
  await send('tap', enrollment.id, card, undefined, 'bad-key');
  assert.equal((await buyer.request('/home')).user.hasCard, 0);
  await send('tap', enrollment.id, card);
  await eventually(async () => (await buyer.request('/home')).user.hasCard === 1);

  const duplicate = await second.request('/card', { device: device.id }, 201);
  await send('tap', duplicate.id, card);
  await eventually(async () => (await second.request('/home')).card.detail?.includes('outra conta'));
  await second.request('/card/' + duplicate.id + '/cancel', {});

  await credit(buyer.id, 5000);
  const salePath = '/teams/' + team.id + '/sales';
  const sale = await seller.request(salePath, { amount: 2000, method: 'rfid' }, 201);
  await eventually(() => armed?.op === sale.id);
  const nonce = randomBytes(16).toString('hex');
  await send('tap', sale.id, card, nonce);
  await send('tap', sale.id, card, nonce);
  await eventually(async () => (await seller.request('/home')).teams[0].sale.status === 'paid');
  assert.equal((await buyer.request('/home')).user.balance, 3000);

  const fallback = await seller.request(salePath, { amount: 4000, method: 'rfid' }, 201);
  await send('tap', fallback.id, card);
  await eventually(async () => (await seller.request('/home')).teams[0].sale.detail === 'Saldo insuficiente.');
  await seller.request(salePath + '/' + fallback.id + '/pix', {});
  await send('tap', fallback.id, card);
  assert.equal((await buyer.request('/home')).user.balance, 3000);
  await credit(buyer.id, 2500);
  await buyer.request('/pix/' + fallback.id, {});
  assert.equal((await buyer.request('/home')).user.balance, 1500);
  assert.equal((await seller.request('/home')).teams[0].balance, 6000);
});
