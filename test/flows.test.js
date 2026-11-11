import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createECDH, randomBytes } from 'node:crypto';
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

test('gestor zera os saldos e exclui alunos ou estabelecimentos em lote', async t => {
  const { admin, students, team, credit, session } = await setup({}, t, 1);
  const [seller, buyer] = students;
  const device = await admin('/admin/devices', { name: 'Terminal da turma' }, 201);
  await admin('/admin/devices/' + device.id + '/link', { team: team.id });
  const bank = (await admin('/home')).user;
  const bankDevice = await admin('/admin/devices', { name: 'Terminal do banco' }, 201);
  await admin('/admin/devices/' + bankDevice.id + '/link', { team: bank.id });
  await credit(team.id, 1000);
  await credit(buyer.id, 2000);
  await admin('/bank/charges', { team: team.id, type: 'fixed', value: 100, description: 'Taxa de teste', request: randomBytes(16).toString('hex') }, 201);
  const [charge] = (await seller.request('/home')).teams[0].charges;
  await seller.request('/bank/charges/' + charge.id + '/pay', {});
  const salePath = '/teams/' + team.id + '/sales';
  const pending = await seller.request(salePath, { amount: 100, method: 'pix' }, 201);
  await buyer.request('/admin/balances/reset', {}, 403);
  await buyer.request('/admin/students/delete-all', {}, 403);
  await buyer.request('/admin/teams/delete-all', {}, 403);
  assert.equal((await admin('/admin/balances/reset', {})).count, 3);
  assert.equal((await admin('/admin/balances/reset', {})).count, 0);
  const reset = await admin('/home');
  assert.equal(reset.user.balance, 0);
  assert.ok(reset.accounts.every(account => account.balance === 0));
  assert.ok(reset.activity.some(entry => entry.id === charge.id));

  assert.equal((await admin('/admin/teams/delete-all', {})).count, 1);
  assert.equal((await admin('/admin/teams/delete-all', {})).count, 0);
  await buyer.request('/pix/' + pending.id, {}, 409);
  const afterTeams = await admin('/home');
  assert.equal(afterTeams.accounts.length, students.length);
  assert.equal(afterTeams.devices.find(item => item.id === device.id).team, null);
  assert.equal(afterTeams.devices.find(item => item.id === bankDevice.id).team, bank.id);

  await admin('/admin/teams', { name: team.name, cnpj: team.cnpj, members: [seller.id] }, 201);
  const [newTeam] = (await seller.request('/home')).teams;
  const sale = await seller.request('/teams/' + newTeam.id + '/sales', { amount: 100, method: 'pix' }, 201);
  assert.equal((await admin('/admin/students/delete-all', {})).count, students.length);
  assert.equal((await admin('/admin/students/delete-all', {})).count, 0);
  await seller.request('/home', undefined, 401);
  await session()('/login', { username: 'aluno1', password: 'AlunoTeste2026' }, 401);
  const final = await admin('/home');
  assert.deepEqual(final.accounts.map(account => account.id), [newTeam.id]);
  assert.deepEqual(final.members, []);
  assert.ok(final.activity.some(entry => entry.id === charge.id));
  await admin('/pix/' + sale.id, {}, 409);
  await admin('/admin/students', { name: 'Novo aluno', username: 'aluno1', password: 'AlunoNovo2026' }, 201);
});

test('zerar histórico limpa os extratos e saldos de todas as contas', async t => {
  const { admin, students: [seller, buyer], team, credit } = await setup({}, t, 1);
  const request = randomBytes(16).toString('hex');
  await credit(buyer.id, 1000, request);
  const sale = await seller.request('/teams/' + team.id + '/sales', { amount: 500, method: 'pix' }, 201);
  await buyer.request('/pix/' + sale.id, {});
  await admin('/bank/charges', { team: team.id, type: 'fixed', value: 100, description: 'Taxa de teste', request: randomBytes(16).toString('hex') }, 201);
  const [charge] = (await seller.request('/home')).teams[0].charges;
  await seller.request('/bank/charges/' + charge.id + '/pay', {});
  await buyer.request('/admin/history/reset', {}, 403);
  await admin('/admin/history/reset', {});
  const home = await admin('/home');
  assert.equal(home.user.balance, 0);
  assert.ok(home.accounts.every(account => account.balance === 0));
  assert.deepEqual(home.activity, []);
  assert.deepEqual((await buyer.request('/home')).activity, []);
  assert.deepEqual((await seller.request('/home')).teams[0].activity, []);
  assert.equal((await admin('/activity/' + sale.id)).amount, 500);
  await credit(buyer.id, 1000, request);
  assert.equal((await buyer.request('/home')).user.balance, 0);
  await credit(buyer.id, 100);
  assert.equal((await buyer.request('/home')).activity[0].amount, 100);
  assert.equal((await admin('/home')).activity.length, 1);
});

test('maquininhas são listadas, nomeadas e vinculadas sem digitar códigos', async t => {
  const { admin, students, team } = await setup({}, t, 1);
  const [seller, second, outsider] = students;
  await admin('/admin/teams', { name: 'Outro comércio', cnpj: '00000000000177', members: [second.id] }, 201);
  const other = (await second.request('/home')).teams[0];
  const device = await admin('/admin/devices', { name: 'Terminal inicial' }, 201);
  const spare = await admin('/admin/devices', { name: 'Terminal reserva' }, 201);
  const available = (await seller.request('/home')).devices.find(item => item.id === device.id);
  assert.equal(available.team, null);
  assert.equal(available.name, 'Terminal inicial');
  assert.equal(available.key, undefined);
  await seller.request('/admin/devices/' + device.id + '/edit', { name: 'Nome proibido' }, 403);
  await admin('/admin/devices/' + device.id + '/edit', { name: 'Caixa principal' });
  assert.equal((await seller.request('/home')).devices.find(item => item.id === device.id).name, 'Caixa principal');
  await outsider.request('/teams/' + team.id + '/device', { device: device.id }, 403);
  await seller.request('/teams/' + team.id + '/device', { device: device.id });
  await seller.request('/teams/' + team.id + '/device', { device: device.id });
  await second.request('/teams/' + other.id + '/device', { device: device.id }, 409);
  await admin('/admin/devices/' + spare.id + '/link', { team: team.id }, 409);
  await seller.request('/admin/devices/' + device.id + '/unlink', {}, 403);
  await admin('/admin/devices/' + device.id + '/unlink', {});
  await admin('/admin/devices/' + device.id + '/unlink', {});
  assert.equal((await seller.request('/home')).teams[0].device, null);
  const contenders = await Promise.allSettled([
    seller.request('/teams/' + team.id + '/device', { device: device.id }),
    second.request('/teams/' + other.id + '/device', { device: device.id })
  ]);
  assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1);
  await admin('/admin/devices/' + device.id + '/unlink', {});
  await admin('/admin/devices/' + device.id + '/link', { team: other.id });
  assert.equal((await second.request('/home')).teams[0].device.id, device.id);
  assert.equal((await admin('/home')).devices.find(item => item.id === device.id).team, other.id);
  await admin('/admin/devices/' + spare.id + '/delete', {});
  await admin('/admin/devices/' + spare.id + '/delete', {}, 404);
  assert.ok(!(await admin('/home')).devices.some(item => item.id === spare.id));
  await second.request('/teams/' + other.id + '/device', { device: spare.id }, 404);
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

test('chaves Pix são reconhecidas, comprovantes são privados e devoluções são integrais', async t => {
  const { admin, students, team, credit } = await setup({}, t, 1);
  const [seller, buyer, outsider] = students;
  const lookup = (actor, key, status) => actor.request('/pix/recipient/auto/' + encodeURIComponent(key), undefined, status);
  assert.equal((await lookup(buyer, '00.000.000/0001-90')).id, team.id);
  assert.equal((await lookup(buyer, 'ALUNO1')).id, seller.id);
  await buyer.request('/pix/keys', { source: team.id, type: 'random' }, 403);
  await seller.request('/pix/keys', { source: team.id, type: 'random' }, 201);
  const keys = (await seller.request('/pix/keys?source=' + team.id)).keys;
  const random = keys.find(key => key.type === 'random');
  assert.equal(keys.find(key => key.type === 'cnpj').value, team.cnpj);
  assert.equal((await lookup(buyer, random.value)).id, team.id);
  await seller.request('/pix/keys', { type: 'email', value: 'Aluno@Example.com' }, 201);
  await buyer.request('/pix/keys', { type: 'email', value: 'aluno@example.com' }, 409);
  await buyer.request('/pix/keys', { type: 'phone', value: '(11) 90000-0000' }, 201);
  await outsider.request('/pix/keys', { type: 'cpf', value: '119.000.000-00' }, 201);
  await lookup(seller, '11900000000', 409);
  assert.equal((await lookup(seller, '+5511900000000')).id, buyer.id);
  assert.equal((await lookup(seller, '119.000.000-00')).id, outsider.id);
  const email = (await seller.request('/pix/keys')).keys.find(key => key.type === 'email');
  assert.equal((await lookup(buyer, email.value)).id, seller.id);

  await credit(buyer.id, 1000);
  const transfer = { recipient: seller.id, key: email.value, amount: 300, request: randomBytes(16).toString('hex') };
  const { id } = await buyer.request('/pix/transfer', transfer);
  const receipt = '/activity/' + id;
  await outsider.request(receipt, undefined, 404);
  await buyer.request(receipt + '/refund', {}, 404);
  assert.equal((await buyer.request(receipt)).canRefund, false);
  assert.equal((await seller.request(receipt)).canRefund, true);
  await seller.request('/pix/transfer', { recipient: team.id, amount: 200, request: randomBytes(16).toString('hex') });
  await seller.request(receipt + '/refund', {}, 409);
  await credit(seller.id, 200);
  const [first, second] = await Promise.all([
    seller.request(receipt + '/refund', {}), seller.request(receipt + '/refund', {})
  ]);
  assert.equal(first.id, second.id);
  assert.equal((await seller.request(receipt)).refundId, first.id);
  const reversal = await buyer.request('/activity/' + first.id);
  assert.equal(reversal.originalId, id);
  assert.equal(reversal.amount, 300);
  assert.equal(reversal.method, 'refund');
  assert.equal((await buyer.request('/home')).user.balance, 1000);
  assert.equal((await admin('/home')).activity.filter(row => row.method === 'refund').length, 1);
  await seller.request('/pix/keys/' + email.id + '/remove', {});
  await outsider.request('/pix/keys', { type: 'email', value: email.value }, 201);
  await buyer.request('/pix/transfer', { ...transfer, request: randomBytes(16).toString('hex') }, 409);
});

test('crédito em todas as contas e cobranças fixas ou percentuais para CNPJ', async t => {
  const { admin, students, team, credit } = await setup({}, t, 1);
  const [seller, second, outsider] = students;
  await admin('/admin/teams', { name: 'Outra oficina', cnpj: '00000000000199', members: [second.id] }, 201);
  const other = (await second.request('/home')).teams[0];
  const bulk = { account: 'all', amount: 1000, request: randomBytes(16).toString('hex') };
  assert.equal((await admin('/admin/credit', bulk)).count, 6);
  assert.equal((await admin('/admin/credit', bulk)).count, 6);
  assert.equal((await seller.request('/home')).user.balance, 1000);
  assert.equal((await seller.request('/home')).teams[0].balance, 1000);

  const fixed = { team: 'all', description: 'Taxa de maquininha', type: 'fixed', value: 200, request: randomBytes(16).toString('hex') };
  await seller.request('/bank/charges', fixed, 403);
  assert.equal((await admin('/bank/charges', fixed, 201)).count, 2);
  assert.equal((await admin('/bank/charges', fixed, 201)).count, 2);
  const percentage = { team: team.id, description: 'IPTU', type: 'percent', value: 1250, request: randomBytes(16).toString('hex') };
  await admin('/bank/charges', percentage, 201);
  await credit(team.id, 500);
  const mine = (await seller.request('/home')).teams[0].charges;
  assert.equal(mine.length, 2);
  const tax = mine.find(charge => charge.description === 'IPTU');
  assert.equal(tax.amount, 125);
  const pay = '/bank/charges/' + tax.id + '/pay';
  await outsider.request(pay, {}, 403);
  await second.request(pay, {}, 403);
  await Promise.all([seller.request(pay, {}), seller.request(pay, {})]);
  assert.equal((await seller.request('/home')).teams[0].balance, 1375);
  assert.equal((await admin('/home')).user.balance, 125);
  assert.equal((await seller.request('/activity/' + tax.id)).description, 'IPTU');
  assert.equal((await seller.request('/activity/' + tax.id)).canRefund, false);
  const otherCharge = (await second.request('/home')).teams[0].charges[0];
  assert.equal(otherCharge.team, other.id);
  await admin('/bank/charges/' + otherCharge.id + '/cancel', {});
  await second.request('/bank/charges/' + otherCharge.id + '/pay', {}, 409);
});

test('gestor salva, relança, edita e exclui cobranças sem alterar lançamentos anteriores', async t => {
  const { admin, students: [seller], team, credit } = await setup({}, t, 1);
  const definition = { team: team.id, type: 'fixed', value: 5000, description: 'Aluguel' };
  await seller.request('/bank/charge-templates', definition, 403);
  const { id } = await admin('/bank/charge-templates', definition, 201);
  const template = '/bank/charge-templates/' + id;
  const charges = async () => (await seller.request('/home')).teams[0].charges;
  assert.deepEqual((await admin('/home')).chargeTemplates, [{ id, ...definition }]);
  assert.deepEqual(await charges(), []);

  const firstRequest = { request: randomBytes(16).toString('hex') };
  await Promise.all([admin(template + '/launch', firstRequest, 201), admin(template + '/launch', firstRequest, 201)]);
  const [first] = await charges();
  assert.equal((await charges()).length, 1);
  await admin(template + '/launch', { request: randomBytes(16).toString('hex') }, 201);
  assert.deepEqual((await charges()).map(charge => charge.amount), [5000, 5000]);
  const second = (await charges()).find(charge => charge.id !== first.id);
  await admin(template + '/edit', { ...definition, value: 10000 });
  await admin(template + '/launch', firstRequest, 201);
  assert.deepEqual((await charges()).map(charge => charge.amount), [5000, 5000]);
  await admin(template + '/launch', { request: randomBytes(16).toString('hex') }, 201);
  assert.deepEqual((await charges()).map(charge => charge.amount).sort((a, b) => a - b), [5000, 5000, 10000]);

  await credit(team.id, 5000);
  const payment = '/bank/charges/' + first.id;
  await seller.request(payment + '/pay', {});
  await admin(payment + '/delete', {});
  assert.equal((await admin('/activity/' + first.id)).amount, 5000);
  assert.equal((await admin('/home')).user.balance, 5000);
  const pending = '/bank/charges/' + second.id;
  await seller.request(pending + '/delete', {}, 403);
  await admin(pending + '/delete', {});
  await seller.request(pending + '/pay', {}, 409);
  await admin(template + '/delete', {});
  await admin(template + '/launch', { request: randomBytes(16).toString('hex') }, 404);
  const home = await admin('/home');
  assert.deepEqual(home.chargeTemplates, []);
  assert.deepEqual(home.charges.map(charge => charge.amount), [10000]);
  assert.deepEqual((await charges()).map(charge => charge.amount), [10000]);
});

test('DRE é exclusiva do gestor e usa as vendas e despesas do estabelecimento no período', async t => {
  const { admin, students: [seller, second, buyer], team, credit } = await setup({}, t, 1);
  await admin('/admin/teams', { name: 'Outro comércio', cnpj: '00000000000333', members: [second.id] }, 201);
  const [otherTeam] = (await second.request('/home')).teams;
  await credit(buyer.id, 50000);
  await credit(team.id, 900);
  const salePath = '/teams/' + team.id + '/sales';
  const first = await seller.request(salePath, { amount: 10000, method: 'pix' }, 201);
  await buyer.request('/pix/' + first.id, {});
  await seller.request('/activity/' + first.id + '/refund', {});
  const secondSale = await seller.request(salePath, { amount: 20000, method: 'pix' }, 201);
  await buyer.request('/pix/' + secondSale.id, {});
  await buyer.request('/pix/transfer', { source: buyer.id, recipient: team.id, amount: 3000, request: randomBytes(16).toString('hex') });
  const charge = { team: team.id, type: 'fixed', value: 4000, description: 'Aluguel', request: randomBytes(16).toString('hex') };
  await admin('/bank/charges', charge, 201);
  const [rent] = (await seller.request('/home')).teams[0].charges;
  await seller.request('/bank/charges/' + rent.id + '/pay', {});
  await admin('/bank/charges', { ...charge, request: randomBytes(16).toString('hex') }, 201);

  const period = '&start=2000-01-01&end=2099-12-31';
  const reportPath = '/admin/dre?team=' + team.id + period;
  await seller.request(reportPath, undefined, 403);
  await admin('/admin/dre?team=' + team.id + '&start=2026-02-30&end=2026-03-01', undefined, 400);
  const dre = await admin(reportPath + '&salesTaxes=1000&costs=3000&expenses=200&incomeTaxes=150');
  assert.equal(dre.account.id, team.id);
  assert.deepEqual([dre.sales, dre.refunds, dre.bankCharges, dre.netRevenue, dre.grossResult, dre.beforeIncomeTaxes, dre.netResult],
    [30000, 10000, 4000, 19000, 16000, 11800, 11650]);
  assert.equal((await admin('/admin/dre?team=' + otherTeam.id + period)).sales, 0);
  assert.equal((await admin('/admin/dre?team=' + team.id + '&start=1999-01-01&end=1999-12-31')).netResult, 0);
});

test('lançamentos para todos alcançam novos estabelecimentos e registram percentuais zerados', async t => {
  const { admin, students: [seller, second], team, credit } = await setup({}, t, 1);
  await admin('/admin/teams/' + team.id + '/delete', {});
  const fixed = { team: 'all', type: 'fixed', value: 6000, description: 'IPTU' };
  const { id } = await admin('/bank/charge-templates', fixed, 201);
  const request = { request: randomBytes(16).toString('hex') };
  const launch = '/bank/charge-templates/' + id + '/launch';
  assert.equal((await admin(launch, request, 201)).count, 0);
  await admin('/admin/teams', { name: 'Primeiro comércio', cnpj: '00000000000211', members: [seller.id] }, 201);
  const [firstTeam] = (await seller.request('/home')).teams;
  assert.deepEqual(firstTeam.charges.map(charge => charge.amount), [6000]);
  assert.equal((await admin(launch, request, 201)).count, 0);
  await admin('/bank/charge-templates/' + id + '/edit', { ...fixed, value: 9000 });

  const percent = { team: 'all', type: 'percent', value: 4000, description: 'Receita Federal' };
  const { id: tax } = await admin('/bank/charge-templates', percent, 201);
  assert.equal((await admin('/bank/charge-templates/' + tax + '/launch', { request: randomBytes(16).toString('hex') }, 201)).count, 1);
  const firstCharges = (await seller.request('/home')).teams[0].charges;
  const zero = firstCharges.find(charge => charge.description === percent.description);
  assert.equal(zero.amount, 0);
  await seller.request('/bank/charges/' + zero.id + '/pay', {});
  assert.deepEqual((await seller.request('/home')).teams[0].activity, []);
  await admin('/bank/charges', { ...fixed, team: firstTeam.id, description: 'Cobrança individual', request: randomBytes(16).toString('hex') }, 201);

  await admin('/admin/teams', { name: 'Segundo comércio', cnpj: '00000000000222', members: [second.id] }, 201);
  const [late] = (await second.request('/home')).teams;
  assert.deepEqual(late.charges.map(charge => [charge.description, charge.amount]), [['IPTU', 6000], ['Receita Federal', 0]]);
  await credit(late.id, 5000);
  assert.equal((await second.request('/home')).teams[0].charges.find(charge => charge.description === percent.description).amount, 0);
  assert.equal((await admin('/home')).user.balance, 0);
});

test('maquininhas online são descobertas e vinculadas sem nome nem chave', async t => {
  const broker = Aedes();
  const listener = createServer(broker.handle).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = 'mqtt://127.0.0.1:' + listener.address().port;
  const { admin, students: [seller], team } = await setup({ MQTT_URL: url }, t, 1);
  const client = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 3000 });
  t.after(async () => {
    client.end(true);
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => listener.close(resolve));
  });
  await once(client, 'connect');
  await client.subscribeAsync('bancofeira/v1/+/status');
  await eventually(async () => (await admin('/home')).mqtt);
  const replies = new Map();
  client.on('message', (_, data) => {
    const reply = JSON.parse(data);
    replies.set(reply.nonce, reply);
  });
  async function discover(id) {
    const exchange = createECDH('prime256v1');
    const pub = exchange.generateKeys('hex');
    async function hello(key) {
      const nonce = randomBytes(16).toString('hex');
      const sig = signature(key, 'hello', id, nonce, '', '');
      await client.publishAsync('bancofeira/v1/' + id + '/event', JSON.stringify({ type: 'hello', nonce, sig, pub }), { qos: 1 });
      await eventually(() => replies.has(nonce));
      return replies.get(nonce);
    }
    const privateKey = exchange.getPrivateKey('hex');
    const offer = await hello(privateKey);
    const key = signature(exchange.computeSecret(offer.pub, 'hex'), 'device', 'bancofeira/v1', id);
    const status = await hello(key);
    assert.equal(status.sig, signature(key, 'status', id, status.nonce, status.time));
    return { hello, privateKey, key, serverPublicKey: offer.pub };
  }

  await admin('/admin/devices', { deviceId: '0042' }, 404);
  const terminal = await discover('0042');
  const first = await seller.request('/home');
  assert.deepEqual(first.availableDevices, [{ id: '0042', name: 'Maquininha 0042', online: true, discovered: true }]);
  assert.equal(first.devices.length, 0);
  await seller.request('/teams/' + team.id + '/device', { device: '0042' });
  assert.equal((await seller.request('/home')).teams[0].device.id, '0042');
  assert.equal((await admin('/home')).availableDevices.length, 0);
  const reconnect = await terminal.hello(terminal.privateKey);
  assert.equal(reconnect.pub, terminal.serverPublicKey);
  const registeredStatus = await terminal.hello(terminal.key);
  assert.equal(registeredStatus.sig, signature(terminal.key, 'status', '0042', registeredStatus.nonce, registeredStatus.time));
  await admin('/admin/devices/0042/unlink', {});
  assert.equal((await admin('/home')).availableDevices[0].id, '0042');
  await admin('/admin/devices/0042/link', { team: team.id });

  await discover('0043');
  await admin('/admin/devices', { deviceId: '0043' }, 201);
  const saved = await admin('/home');
  assert.equal(saved.availableDevices[0].id, '0043');
  assert.equal(saved.devices.find(device => device.id === '0043').team, null);
  await discover('0044');
  await discover('0044');
  assert.ok(!(await admin('/home')).availableDevices.some(device => device.id === '0044'));
  await admin('/admin/devices', { deviceId: '0044' }, 409);
});

test('MQTT com dispositivo simulado, vínculo de RFID, cartão duplicado e conversão em Pix', async t => {
  const broker = Aedes();
  const listener = createServer(broker.handle).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = 'mqtt://127.0.0.1:' + listener.address().port;
  const { admin, students, team, credit } = await setup({ MQTT_URL: url }, t);
  const [seller, second, third, buyer] = students;
  const registration = { name: 'RC522 de teste', deviceId: '5831', deviceKey: randomBytes(32).toString('hex') };
  await buyer.request('/admin/devices', registration, 403);
  await admin('/admin/devices', { ...registration, deviceKey: '1234' }, 400);
  const device = await admin('/admin/devices', registration, 201);
  assert.equal(device.id, registration.deviceId);
  assert.equal(device.key, registration.deviceKey);
  await admin('/admin/devices', registration, 409);
  const client = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 3000 });
  t.after(async () => {
    client.end(true);
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => listener.close(resolve));
  });
  await once(client, 'connect');
  const base = 'bancofeira/v1/' + device.id;
  await client.subscribeAsync([base + '/arm', base + '/status']);
  let armed, confirmation;
  client.on('message', (topic, data) => {
    if (topic.endsWith('/arm')) armed = JSON.parse(data.toString());
    if (topic.endsWith('/status')) confirmation = JSON.parse(data.toString());
  });
  const send = (type, op = '', card = '', nonce = randomBytes(16).toString('hex'), key = device.key) =>
    client.publishAsync(base + '/event', JSON.stringify({
      type, op, card, nonce, sig: signature(key, type, device.id, nonce, op, card)
    }), { qos: 1 });
  await seller.request('/teams/' + team.id + '/device', { pairing: device.pairing });
  await eventually(async () => (await admin('/home')).mqtt);
  const helloNonce = randomBytes(16).toString('hex');
  await send('hello', '', '', helloNonce);
  await eventually(() => confirmation?.nonce === helloNonce);
  assert.equal(confirmation.sig, signature(device.key, 'status', device.id, helloNonce, confirmation.time));
  assert.ok(Math.abs(Number(confirmation.time) * 1000 - Date.now()) < 5000);
  await eventually(async () => (await admin('/home')).devices[0].online);
  assert.equal((await admin('/home')).devices[0].team, team.id);
  const confirmed = confirmation;
  await send('hello', '', '', randomBytes(16).toString('hex'), 'wrong-key');
  await delay(60);
  assert.equal(confirmation, confirmed);

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

  const bankId = (await admin('/home')).user.id;
  await admin('/admin/devices/' + device.id + '/unlink', {});
  await admin('/admin/devices/' + device.id + '/link', { team: bankId });
  assert.equal((await admin('/home')).devices[0].ownerRole, 'admin');
  const enrollmentPath = '/admin/students/' + third.id + '/card';
  await seller.request(enrollmentPath, {}, 403);
  await third.request('/card', { device: device.id }, 400);
  const abandoned = await admin(enrollmentPath, {}, 201);
  await admin('/card/' + abandoned.id + '/cancel', {});
  assert.equal((await admin('/home')).cardEnrollment.status, 'cancelled');
  const bankEnrollment = await admin(enrollmentPath, {}, 201);
  await eventually(() => armed?.op === bankEnrollment.id);
  await admin('/admin/students/' + second.id + '/card', {}, 409);
  await send('tap', bankEnrollment.id, 'A1B2C3D4');
  await eventually(async () => (await admin('/home')).cardEnrollment.status === 'linked');
  assert.equal((await third.request('/home')).user.hasCard, 1);
  await admin('/admin/devices/' + device.id + '/unlink', {});
  await admin('/admin/devices/' + device.id + '/link', { team: team.id });

  assert.equal((await admin('/home')).terminalFeeRate, 0);
  await seller.request('/bank/terminal-fee', { rate: 1000 }, 403);
  await admin('/bank/terminal-fee', { rate: 10001 }, 400);
  await admin('/bank/terminal-fee', { rate: 1000 });
  assert.equal((await admin('/home')).terminalFeeRate, 1000);
  await credit(buyer.id, 4000);
  const salePath = '/teams/' + team.id + '/sales';
  const sale = await seller.request(salePath, { amount: 1000, method: 'rfid' }, 201);
  await eventually(() => armed?.op === sale.id);
  const nonce = randomBytes(16).toString('hex');
  await send('tap', sale.id, card, nonce);
  await send('tap', sale.id, card, nonce);
  await eventually(async () => (await seller.request('/home')).teams[0].sale.status === 'paid');
  assert.equal((await buyer.request('/home')).user.balance, 3000);
  const { teams: [paidTeam] } = await seller.request('/home');
  assert.equal(paidTeam.balance, 900);
  const bank = (await admin('/home')).user;
  assert.equal(bank.balance, 100);
  const [fee] = paidTeam.activity.filter(entry => entry.method === 'terminal_fee');
  assert.equal(paidTeam.activity.filter(entry => entry.method === 'terminal_fee').length, 1);
  assert.deepEqual([fee.payer, fee.payee, fee.amount], [team.id, bank.id, 100]);
  const drePath = '/admin/dre?team=' + team.id + '&start=2000-01-01&end=2099-12-31';
  assert.equal((await admin(drePath)).terminalFees, 100);
  assert.deepEqual(paidTeam.activity.filter(entry => entry.id === sale.id).map(entry => [entry.payee, entry.amount]), [[team.id, 1000]]);
  await admin('/bank/terminal-fee', { rate: 2000 });

  const fallback = await seller.request(salePath, { amount: 4000, method: 'rfid' }, 201);
  await send('tap', fallback.id, card);
  await eventually(async () => (await seller.request('/home')).teams[0].sale.detail === 'Saldo insuficiente.');
  await seller.request(salePath + '/' + fallback.id + '/pix', {});
  await send('tap', fallback.id, card);
  assert.equal((await buyer.request('/home')).user.balance, 3000);
  await credit(buyer.id, 2500);
  await buyer.request('/pix/' + fallback.id, {});
  assert.equal((await buyer.request('/home')).user.balance, 1500);
  assert.equal((await seller.request('/home')).teams[0].balance, 4900);
  assert.equal((await admin('/home')).user.balance, 100);
  const receipt = await seller.request('/activity/' + sale.id);
  assert.equal(receipt.canRefund, true);
  assert.equal(receipt.terminalFee, 100);
  const reversal = await seller.request('/activity/' + sale.id + '/refund', {});
  assert.deepEqual(await seller.request('/activity/' + sale.id + '/refund', {}), reversal);
  assert.equal((await buyer.request('/home')).user.balance, 2500);
  assert.equal((await seller.request('/home')).teams[0].balance, 4000);
  assert.equal((await admin('/home')).user.balance, 0);
  assert.equal((await admin(drePath)).terminalFees, 0);
  const feeReceipt = await seller.request('/activity/' + fee.id);
  assert.ok(feeReceipt.refundId);
  assert.equal((await seller.request('/activity/' + feeReceipt.refundId)).amount, 100);

  const bankLimit = 100_000_000_000;
  await credit(team.id, bankLimit - 4000);
  await admin('/bank/charges', { team: team.id, type: 'fixed', value: bankLimit, description: 'Limite do banco', request: randomBytes(16).toString('hex') }, 201);
  const [charge] = (await seller.request('/home')).teams[0].charges;
  await seller.request('/bank/charges/' + charge.id + '/pay', {});
  const blocked = await seller.request(salePath, { amount: 1000, method: 'rfid' }, 201);
  await send('tap', blocked.id, card);
  await eventually(async () => (await seller.request('/home')).teams[0].sale.detail?.includes('limite de saldo'));
  assert.equal((await buyer.request('/home')).user.balance, 2500);
  assert.equal((await seller.request('/home')).teams[0].balance, 0);
  await seller.request('/activity/' + blocked.id, undefined, 404);
  await seller.request(salePath + '/' + blocked.id + '/cancel', {});

  const cancelled = await seller.request(salePath, { amount: 500, method: 'rfid' }, 201);
  const remove = '/admin/devices/' + device.id + '/delete';
  await seller.request(remove, {}, 403);
  await admin(remove, {});
  await send('tap', cancelled.id, card);
  const { teams: [sellerTeam], devices } = await seller.request('/home');
  assert.equal(sellerTeam.sale.status, 'cancelled');
  assert.equal(sellerTeam.device, null);
  assert.ok(!devices.some(item => item.id === device.id));
  assert.equal((await seller.request('/activity/' + sale.id)).id, sale.id);
  const { user } = await buyer.request('/home');
  assert.equal(user.balance, 2500);
  assert.equal(user.hasCard, 1);
  await admin('/admin/devices', { ...registration, deviceKey: randomBytes(32).toString('hex') }, 201);
  await admin('/admin/devices/' + device.id + '/link', { team: team.id });
  await send('hello');
  await delay(60);
  assert.equal((await admin('/home')).devices[0].online, false);
});
