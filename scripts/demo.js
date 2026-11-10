import { openDb, get, initAdmin, passwordHash, run, transfer, transaction, uid } from '../server/db.js';
import { createApp } from '../server/app.js';

const db = openDb('./data/demo.sqlite');
const config = { ADMIN_USER: 'gestor', ADMIN_PASSWORD: 'FeiraDemo2026' };
initAdmin(db, config.ADMIN_USER, config.ADMIN_PASSWORD);
if (!get(db, "SELECT 1 FROM accounts WHERE role='student'")) {
  const admin = get(db, "SELECT id FROM accounts WHERE role='admin'").id;
  const names = ['Ana Lima', 'Bia Souza', 'Caio Rocha', 'Davi Melo', 'Eva Alves', 'Felipe Dias',
    'Gabi Ramos', 'Hugo Reis', 'Iara Torres', 'João Costa', 'Lia Silva', 'Nina Freitas'];
  const stores = ['Doce Ponto', 'Papel & Cor', 'Sabor da Horta', 'Estação Criativa'];
  const pass = passwordHash('FeiraDemo2026');
  transaction(db, () => {
    const teams = stores.map((name, index) => {
      const id = uid();
      run(db, "INSERT INTO accounts (id,name,role,cnpj) VALUES (?,?,'team',?)", id, name, '0000000000010' + index);
      transfer(db, { payee: id, amount: 15000, method: 'credit', actor: admin });
      return id;
    });
    names.forEach((name, index) => {
      const id = uid();
      run(db, "INSERT INTO accounts (id,name,role,username,password) VALUES (?,?,'student',?,?)",
        id, name, 'aluno' + (index + 1), pass);
      run(db, 'INSERT INTO members VALUES (?,?)', teams[Math.floor(index / 3)], id);
      transfer(db, { payee: id, amount: 8000, method: 'credit', actor: admin });
      if (index % 3 === 0) transfer(db, { payer: id, payee: teams[(index / 3 + 1) % 4], amount: 1250, method: 'pix', actor: id });
    });
  });
}
const { app, close } = createApp(db, config);
const server = app.listen(Number(process.env.PORT || 3000), '127.0.0.1', () =>
  console.log('Banco Virtual em http://localhost:' + server.address().port + ' · gestor ou aluno1 · senha FeiraDemo2026'));
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { close(); server.close(() => db.close()); });
