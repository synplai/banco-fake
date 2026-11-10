const app = document.querySelector('#app');
const modal = document.querySelector('#dialog');
const toast = document.querySelector('#toast');
const state = { data: null, page: 'overview', balance: true, running: false, loginError: '' };
let timer, camera, scanFrame, events, generation = 0, refreshQueued = false;
const paths = {
  home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 21v-7h6v7"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4"/><circle cx="9" cy="7" r="4"/><path d="M16 3a4 4 0 0 1 0 8"/>',
  shop: '<path d="M3 10v10h18V10M3 10l2-6h14l2 6M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0m-11 10v-5h4v5"/>',
  device: '<rect x="6" y="2" width="12" height="20" rx="3"/><rect x="9" y="5" width="6" height="5" rx="1"/><path d="M10 14h4m-4 4h4"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20m-15 5h4"/>',
  pix: '<path d="M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>', up: '<path d="M6 18 18 6M6 6h12v12"/>', down: '<path d="M18 6 6 18m0-12v12h12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', exit: '<path d="M10 17l5-5-5-5m5 5H3m9-8h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/>',
  history: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="m5 12 4 4L19 6"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
  wifi: '<path d="M2 8a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0m-11 4a5 5 0 0 1 8 0m-4 4h.01"/>',
  backspace: '<path d="M22 6v12H8l-6-6 6-6zM11 9l6 6m0-6-6 6"/>',
  edit: '<path d="m13 6 5 5M4 20l4-.9L20 7l-4-4L4 15z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>'
};
const icon = name => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => escapeMap[char]);
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = cents => currency.format(cents / 100);
const date = value => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(value);
const initials = name => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const brand = '<div class="brand"><img src="/logo.svg" alt=""><span>Banco<span class="brand-accent"> Virtual</span><small>LABORATÓRIO FINANCEIRO</small></span></div>';
const pill = (text, style = '') => '<span class="pill ' + style + '"><i></i>' + esc(text) + '</span>';
const button = (label, action, iconName, style = 'primary', id = '') =>
  '<button type="button" class="btn ' + style + '" data-action="' + action + '" data-id="' + esc(id) + '">' + (iconName ? icon(iconName) : '') + esc(label) + '</button>';
const empty = (title, description, type = 'history') => '<div class="empty"><span class="tile-icon">' + icon(type) + '</span><strong>' + esc(title) + '</strong><p>' + esc(description) + '</p></div>';
const section = (title, description, body, right = '') => '<section class="panel"><div class="panel-head"><div><h2>' + esc(title) + '</h2><p>' + esc(description) + '</p></div>' + right + '</div>' + body + '</section>';

async function api(path, data) {
  const response = await fetch('/api' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
  return body;
}
function notice(message, error = false) {
  clearTimeout(timer);
  toast.textContent = message;
  toast.className = error ? 'error' : '';
  toast.hidden = false;
  timer = setTimeout(() => { toast.hidden = true; }, 4500);
}
async function refresh(force = false) {
  if (state.running && !force) { refreshQueued = true; return; }
  const request = ++generation;
  state.running = true;
  try {
    const data = await api('/home');
    if (request !== generation) return;
    const changed = JSON.stringify(data) !== JSON.stringify(state.data);
    const navChanged = data.teams?.length !== state.data?.teams?.length;
    const nameChanged = data.user.name !== state.data?.user.name;
    state.data = data;
    if (data.user.role === 'student' && state.page === 'teams' && !data.teams.length) state.page = 'overview';
    if (changed || force) {
      if (navChanged || nameChanged || !document.querySelector('.shell')) render();
      else drawPage();
    }
    if (!events) {
      events = new EventSource('/api/events');
      events.addEventListener('update', () => { if (!document.hidden) refresh(); });
    }
  } catch (error) {
    if (request !== generation) return;
    if (error.status === 401) {
      if (state.data) modal.close();
      events?.close();
      events = null;
      state.data = null;
      if (!document.querySelector('#login-form')) render();
    } else if (force || !state.data) {
      if (!state.data) render();
      notice('Não foi possível atualizar o banco. Tente novamente.', true);
    }
  } finally {
    if (request === generation) {
      state.running = false;
      if (refreshQueued) {
        refreshQueued = false;
        if (state.data) refresh();
      }
    }
  }
}
function loginView() {
  return '<main class="login-layout"><section class="login-hero">' + brand +
    '<div class="login-message"><span class="eyebrow"><i></i> EXPERIÊNCIA DE SALA DE AULA</span>' +
    '<h1>Seu banco.<br>Na <em>prática.</em></h1><p>Aprenda a vender, pagar e cuidar do seu dinheiro.</p></div>' +
    '<div class="login-art"><div class="art-ring"></div><div class="art-card"><img src="/logo.svg" alt=""><span>BANCO VIRTUAL</span><b>Cartão Virtual</b><small>•••• &nbsp; ••••</small>' + icon('wifi') + '</div></div>' +
    '<div class="login-foot">FEITO PARA APRENDER <span>01 / BANCO VIRTUAL</span></div></section>' +
    '<section class="login-content"><div class="login-box">' + brand + '<span class="tag">● &nbsp; SIMULAÇÃO EDUCACIONAL</span><h2>Bem-vindo!</h2>' +
    '<p>Entre com o usuário que o gestor entregou a você.</p><form id="login-form">' +
    '<label>Usuário<input name="username" placeholder="Seu nome de usuário" autocomplete="username" autocapitalize="none" required></label>' +
    '<label>Senha<input type="password" name="password" placeholder="Sua senha" autocomplete="current-password" required></label>' +
    '<p class="form-error" role="alert"></p><button class="btn primary login-submit">Entrar no banco' + icon('arrow') + '</button></form>' +
    '<div class="login-note">' + icon('card') + '<span>Todos os saldos e pagamentos são fictícios.</span></div></div></section></main>';
}

const methods = { credit: 'Crédito do gestor', pix: 'Pix', rfid: 'Cartão RFID', refund: 'Devolução', fee: 'Cobrança do banco' };
function activity(rows, owner) {
  if (!rows.length) return empty('Tudo pronto por aqui', 'As movimentações aparecem neste espaço.');
  return '<ul class="activity">' + rows.map(row => {
    const outgoing = row.payer === owner;
    const title = owner ? (outgoing ? row.toName : row.fromName || 'Crédito do gestor') : (row.fromName ? row.fromName + ' → ' + row.toName : row.toName);
    return '<li><button type="button" class="activity-row" data-action="receipt" data-id="' + esc(row.id) + '"><span class="tile-icon ' + (outgoing ? 'spent' : 'received') + '">' + icon(outgoing ? 'up' : 'down') + '</span><span><strong>' +
      esc(title) + '</strong><small>' + methods[row.method] + ' · ' + date(row.created) + '</small></span><b class="' + (outgoing ? '' : 'positive') + '">' +
      (owner ? (outgoing ? '− ' : '+ ') : '') + money(row.amount) + '</b>' + icon('arrow') + '</button></li>';
  }).join('') + '</ul>';
}
const adminNav = [['overview', 'Visão geral', 'home'], ['students', 'Alunos', 'users'], ['teams', 'Estabelecimentos', 'shop'],
  ['charges', 'Cobranças', 'history'], ['devices', 'Maquininhas', 'device']];
const studentNav = [['overview', 'Minha conta', 'home'], ['teams', 'Meu estabelecimento', 'shop']];
const navItems = () => state.data.user.role === 'admin' ? adminNav : studentNav.filter(item => item[0] !== 'teams' || state.data.teams.length);
function render() {
  if (!state.data) { app.innerHTML = loginView(); return; }
  const user = state.data.user;
  app.innerHTML = '<div class="shell"><aside class="sidebar">' + brand + '<div class="nav-label">ESPAÇO ' + (user.role === 'admin' ? 'DO GESTOR' : 'DO ALUNO') + '</div><nav aria-label="Menu principal">' +
    navItems().map(([id, title, type]) => '<button data-action="page" data-id="' + id + '">' + icon(type) + '<span>' + title + '</span></button>').join('') +
    '</nav><div class="side-bottom"><span><i></i> Ambiente de simulação</span><button data-action="logout">' + icon('exit') + '<span>Sair da conta</span></button></div></aside>' +
    '<div class="workspace"><header class="topbar"><div class="mobile-brand">' + brand + '</div><span class="top-crumb" id="crumb"></span><div class="top-profile"><span class="profile-text">' +
    esc(user.name) + '<small>' + (user.role === 'admin' ? 'Gestor do banco' : 'Conta de aluno') + '</small></span><span class="avatar">' + esc(initials(user.name)) +
    '</span><button class="mobile-exit icon-btn" data-action="logout" aria-label="Sair">' + icon('exit') + '</button></div></header><main id="page" class="main"></main></div></div>';
  drawPage();
}
function drawPage() {
  document.querySelector('#crumb').textContent = navItems().find(item => item[0] === state.page)?.[1] || 'Banco Virtual';
  for (const item of document.querySelectorAll('nav button')) {
    if (item.dataset.id === state.page) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  const page = document.querySelector('#page');
  const html = state.data.user.role === 'admin' ? adminPage() : studentPage();
  if (page.dataset.rendered !== html) {
    const focused = page.contains(document.activeElement) ? document.activeElement.dataset : null;
    page.innerHTML = html;
    page.dataset.rendered = html;
    if (focused?.action) Array.from(page.querySelectorAll('button')).find(b => b.dataset.action === focused.action && b.dataset.id === focused.id)?.focus();
  }
}
const intro = (eyebrow, title, subtitle, right = '') => '<div class="intro"><div><span class="eyebrow">' + esc(eyebrow) + '</span><h1>' + esc(title) + '</h1><p>' + esc(subtitle) + '</p></div>' + right + '</div>';
const metrics = (label, value, description, type, style) => '<div class="metric"><span class="tile-icon ' + style + '">' + icon(type) + '</span><span>' + label + '</span><strong>' + value + '</strong><small>' + description + '</small></div>';
function adminPage() {
  const { accounts, members, devices, mqtt, charges, activity: rows } = state.data;
  const students = accounts.filter(x => x.role === 'student');
  const teams = accounts.filter(x => x.role === 'team');
  if (state.page === 'overview') {
    return intro('PAINEL DO GESTOR', 'Visão geral do banco', 'Acompanhe contas, estabelecimentos e pagamentos em um só lugar.', button('Liberar saldo', 'credit', 'plus')) +
      '<div class="hero admin-hero"><div><span class="eyebrow"><i></i> BANCO VIRTUAL</span><h2>Dinheiro de brincadeira.<br>Aprendizado de verdade.</h2><p>Cadastre alunos, organize os estabelecimentos e dê início às vendas.</p></div><div class="hero-mark" aria-hidden="true">B<span>.</span></div><span class="hero-index">01 &nbsp; / &nbsp; SIMULAÇÃO</span></div>' +
      '<div class="metrics">' + metrics('Alunos', students.length, students.filter(x => x.hasCard).length + ' com cartão RFID', 'users', 'purple') +
      metrics('Estabelecimentos', teams.length, 'CNPJs fictícios cadastrados', 'shop', 'lime') +
      metrics('Maquininhas', devices.length, devices.filter(x => x.online).length + ' online agora', 'device', 'peach') +
      metrics('Saldo em circulação', money(accounts.reduce((sum, x) => sum + x.balance, state.data.user.balance)), 'Total nas contas ativas', 'card', 'blue') + '</div>' +
      section('Conta do banco', 'Saldo disponível · ' + money(state.data.user.balance),
        '<div class="panel-actions pix-actions">' + button('Enviar Pix', 'pix-send', 'up', 'ghost') +
        button('Pagar cobrança', 'pix', 'pix', 'ghost') + button('Minhas chaves Pix', 'pix-keys', null, 'ghost') + '</div>') +
      section('Movimentações recentes', 'Créditos e pagamentos de todas as contas', activity(rows), pill('Simulação', 'neutral'));
  }
  if (state.page === 'students') return intro('CADASTROS', 'Alunos', 'Veja quem já vinculou o cartão e gerencie as contas.', button('Cadastrar aluno', 'student', 'plus')) +
    section('Contas pessoais', students.length + ' aluno(s) · ' + students.filter(x => !x.hasCard).length + ' sem cartão', students.length ?
      '<div class="records">' + students.map(x => record(x.name, '@' + x.username, 'users', pill(x.hasCard ? 'Com cartão' : 'Sem cartão', x.hasCard ? 'good' : 'neutral') +
      '<b>' + money(x.balance) + '</b>' + button('Crédito', 'credit', 'plus', 'ghost', x.id) +
      button('Editar', 'student', 'edit', 'ghost', x.id) +
      button('Excluir', 'delete-account', 'trash', 'danger-ghost', x.id) +
      (x.hasCard ? button('Desvincular', 'unlink', null, 'ghost', x.id) : ''))).join('') + '</div>' : empty('Nenhum aluno cadastrado', 'Crie o primeiro login da turma.', 'users'));
  if (state.page === 'teams') return intro('CONTAS COMERCIAIS', 'Estabelecimentos', 'Cadastre CNPJs fictícios e escolha quem pode operar cada conta.', button('Cadastrar estabelecimento', 'team', 'plus')) +
    section('Contas de venda', teams.length + (teams.length === 1 ? ' estabelecimento' : ' estabelecimentos'), teams.length ? '<div class="records">' + teams.map(x => record(x.name,
      'CNPJ ' + x.cnpj + ' · ' + (members.filter(m => m.team === x.id).map(m => students.find(s => s.id === m.student)?.name).join(', ') || 'Sem alunos autorizados'), 'shop',
      '<b>' + money(x.balance) + '</b>' + button('Crédito', 'credit', 'plus', 'ghost', x.id) +
      button('Maquininha', 'pair', 'device', 'ghost', x.id) +
      button('Editar', 'team', 'edit', 'ghost', x.id) + button('Excluir', 'delete-account', 'trash', 'danger-ghost', x.id))).join('') + '</div>' : empty('Nenhum estabelecimento cadastrado', 'Cadastre pelo menos um aluno para operar a conta.', 'shop'));
  if (state.page === 'charges') return intro('CONTA DO BANCO', 'Cobranças', 'Lance taxas, impostos simulados ou aluguel para os estabelecimentos.', button('Nova cobrança', 'charge-new', 'plus')) +
    section('Cobranças emitidas', 'Acompanhe os valores pendentes, pagos e cancelados.', bankCharges(charges, true));
  return intro('CARTÃO E CONECTIVIDADE', 'Maquininhas', 'Acompanhe a conexão e o CNPJ vinculado a cada ESP32.', button('Registrar maquininha', 'device', 'plus')) +
    section('Terminais RFID', 'Conexão do servidor com o broker MQTT', devices.length ? '<div class="records">' +
      devices.map(d => record(d.name, (/^\d{4}$/.test(d.id) ? 'ID ' + d.id + ' · ' : '') +
        (d.teamName ? d.teamName + ' · CNPJ ' + teams.find(x => x.id === d.team)?.cnpj : 'Sem estabelecimento vinculado'), 'device',
        pill(d.online ? 'Online' : 'Offline', d.online ? 'good' : 'neutral') +
        button('Renomear', 'device-name', 'edit', 'ghost', d.id) +
        (d.team ? button('Desvincular', 'device-unlink', null, 'danger-ghost', d.id) :
          button('Vincular', 'device-link', 'device', 'ghost', d.id)))).join('') +
      '</div>' : empty('Nenhuma maquininha registrada', 'Cadastre o ESP32 para disponibilizá-lo na lista.', 'device'), pill(mqtt ? 'MQTT conectado' : 'MQTT indisponível', mqtt ? 'good' : 'neutral'));
}
function record(title, subtitle, type, actions) {
  return '<div class="record"><span class="tile-icon purple">' + icon(type) + '</span><div class="record-name"><strong>' + esc(title) + '</strong><small>' + esc(subtitle) + '</small></div><div class="record-actions">' + actions + '</div></div>';
}
function bankCharges(charges, manager = false) {
  if (!charges?.length) return empty(manager ? 'Nenhuma cobrança lançada' : 'Nenhuma cobrança pendente',
    manager ? 'As cobranças lançadas pelo banco aparecem aqui.' : 'Taxas e outras cobranças do banco aparecem aqui.');
  return '<div class="records">' + charges.map(charge => {
    const status = charge.paid_at ? 'Paga' : charge.cancelled_at ? 'Cancelada' : 'Pendente';
    const basis = charge.rate === null ? 'Valor fixo' : (charge.rate / 100).toLocaleString('pt-BR') + '% sobre o saldo no lançamento';
    const description = [manager ? charge.teamName : '', basis, date(charge.created)].filter(Boolean).join(' · ');
    const action = charge.paid_at ? button('Comprovante', 'receipt', null, 'ghost', charge.id) : charge.cancelled_at ? '' :
      manager ? button('Cancelar', 'charge-cancel', null, 'danger-ghost', charge.id) :
        button('Pagar', 'charge-pay', 'pix', 'primary', charge.id);
    return record(charge.description, description, 'history', '<b>' + money(charge.amount) + '</b>' +
      pill(status, charge.paid_at ? 'good' : 'neutral') + action);
  }).join('') + '</div>';
}
function studentPage() {
  const { user, teams, activity: rows, card } = state.data;
  if (state.page === 'teams' && teams.length) return teamPage(teams[0]);
  const isPending = card?.status === 'pending';
  const cardMessage = isPending ? (card.detail || 'Aproxime seu cartão da maquininha escolhida.') :
    card?.status === 'expired' ? 'O tempo para vincular acabou. Você pode tentar novamente.' :
    user.hasCard ? 'Pronto para pagar nos estabelecimentos.' : 'Vincule um cartão para pagar por aproximação.';
  return intro('MINHA CONTA', 'Olá, ' + user.name.split(' ')[0] + '!', 'Sua conta para fazer pagamentos e acompanhar seus gastos.') +
    '<div class="student-grid"><div class="hero balance-hero"><div><span class="eyebrow"><i></i> SALDO DISPONÍVEL</span><div class="balance-value">' +
    (state.balance ? money(user.balance) : 'R$ ••••') + '<button class="icon-btn" data-action="balance" aria-label="' +
    (state.balance ? 'Ocultar saldo' : 'Mostrar saldo') + '">' + icon('eye') + '</button></div><p>Reais fictícios · Conta pessoal</p></div><div class="hero-mark" aria-hidden="true">B<span>.</span></div></div>' +
    '<section class="panel quick"><h2>O que vamos fazer?</h2><div class="quick-grid">' +
    '<button data-action="pix-send"><span class="tile-icon lime">' + icon('up') + '</span><strong>Enviar Pix</strong><small>Por chave Pix</small></button>' +
    '<button data-action="pix"><span class="tile-icon lime">' + icon('pix') + '</span><strong>Pagar cobrança</strong><small>QR Code ou código Pix</small></button>' +
    '<button data-action="pix-keys"><span class="tile-icon purple">' + icon('plus') + '</span><strong>Minhas chaves Pix</strong><small>Criar ou copiar</small></button>' +
    '<button data-action="card"><span class="tile-icon purple">' + icon('card') + '</span><strong>Vincular cartão</strong><small>Pagamento RFID</small></button></div></section></div>' +
    section('Meu cartão', cardMessage, isPending ? '<div class="panel-actions">' + button('Cancelar vínculo', 'card-cancel', null, 'ghost', card.id) + '</div>' : '',
      pill(isPending ? 'Aguardando' : user.hasCard ? 'Vinculado' : 'Sem cartão', user.hasCard && !isPending ? 'good' : 'neutral')) +
    section('Meu extrato', 'Últimas movimentações da sua conta pessoal', activity(rows, user.id));
}
function teamPage(team) {
  const sale = team.sale;
  const active = sale?.status === 'pending';
  const qr = '/api/teams/' + team.id + '/sales/' + sale?.id + '/qr';
  const code = 'BANCOVIRTUAL:' + sale?.id;
  return intro('CONTA DO ESTABELECIMENTO', team.name, 'CNPJ fictício ' + team.cnpj, active ? '' : button('Efetuar venda', 'sale', 'plus', 'primary', team.id)) +
    '<div class="student-grid"><div class="hero balance-hero"><div><span class="eyebrow"><i></i> SALDO DO ESTABELECIMENTO</span><div class="balance-value">' +
    money(team.balance) + '</div><p>Reais fictícios · Conta comercial</p><div class="pix-actions">' +
    button('Enviar Pix', 'pix-send', 'up', 'ghost', team.id) + button('Pagar cobrança', 'pix', 'pix', 'ghost', team.id) +
    button('Minhas chaves Pix', 'pix-keys', null, 'ghost', team.id) +
    '</div></div><div class="hero-mark" aria-hidden="true">B<span>.</span></div></div>' +
    section('Maquininha', team.device?.name || 'Vincule o leitor RFID do estabelecimento.', team.device ? '' : '<div class="panel-actions">' +
    button('Vincular maquininha', 'pair', 'device', 'ghost', team.id) + '</div>', team.device ? pill(team.device.online ? 'Online' : 'Offline', team.device.online ? 'good' : 'neutral') : '') + '</div>' +
    (active ? section('Cobrança em aberto', 'Aguardando pagamento · ' + money(sale.amount), '<div class="sale-status">' +
      (sale.method === 'pix' ? '<img class="qr" width="220" height="220" src="' + qr + '" alt="QR Code do Pix fictício"><div class="pix-details"><h3>Pix simulado</h3><p>Peça ao cliente para abrir Pagar cobrança no banco.</p>' +
        '<p class="pix-code-label">Código Pix copia e cola</p><code class="pix-code">' + esc(code) + '</code>' +
        button('Copiar código', 'copy', null, 'ghost', code) + '</div>' :
        '<span class="tile-icon purple">' + icon('wifi') + '</span><div><h3>Aproxime o cartão</h3><p>' + esc(sale.detail || 'A maquininha está aguardando o cartão do cliente.') + '</p>' +
        button('Gerar QR Code Pix', 'sale-pix', 'pix', 'primary', sale.id) + '</div>') +
        '</div><div class="panel-actions">' + button('Cancelar cobrança', 'sale-cancel', null, 'ghost', sale.id) + '</div>', pill(sale.method === 'pix' ? 'Pix' : 'Cartão RFID', 'neutral')) :
      sale?.status === 'paid' ? '<div class="confirmation">' + icon('check') + '<span>Pagamento recebido</span><strong>' + money(sale.amount) + '</strong></div>' :
      sale?.status === 'expired' ? '<div class="confirmation neutral">A última cobrança expirou. Você já pode criar outra.</div>' : '') +
    section('Cobranças do banco', 'Consulte e pague com o saldo do estabelecimento.', bankCharges(team.charges)) +
    section('Extrato do estabelecimento', 'Créditos, vendas e pagamentos', activity(team.activity, team.id));
}

function showDialog(title, description, content) {
  stopCamera();
  modal.innerHTML = '<div class="dialog-head"><div><h2 id="dialog-title">' + esc(title) + '</h2><p>' + esc(description) + '</p></div><button class="icon-btn" data-action="close" aria-label="Fechar">' + icon('close') + '</button></div>' + content;
  if (!modal.open) modal.showModal();
}
function form(fields, label, style = 'primary') {
  return '<form id="dialog-form">' + fields + '<p class="form-error" role="alert"></p><button class="btn ' + style + '">' + esc(label) + icon('arrow') + '</button></form>';
}
const input = (label, name, attrs = '', required = true) =>
  '<label>' + label + '<input name="' + name + '" ' + attrs + (required ? ' required' : '') + '></label>';
const select = (label, name, options, selected = '') => '<label>' + label + '<select name="' + name + '" required><option value="">Selecione</option>' +
  options.map(x => '<option value="' + esc(x.id) + '"' + (selected === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></label>';
function cents(value) {
  if (!/^\d{1,10}(?:[,.]\d{1,2})?$/.test(value.trim())) throw new Error('Digite um valor como 25,50.');
  const [integer, decimal = ''] = value.trim().split(/[,.]/);
  return Number(integer) * 100 + Number(decimal.padEnd(2, '0'));
}
const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
function onForm(handler) {
  modal.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const target = event.currentTarget;
    const submit = event.submitter || target.querySelector('button[type=submit], button:not([type])');
    const error = target.querySelector('.form-error');
    if (submit?.disabled) return;
    if (submit) submit.disabled = true;
    error.textContent = '';
    try { await handler(Object.fromEntries(new FormData(target)), target, submit); }
    catch (e) { error.textContent = e.message; }
    finally { if (submit) submit.disabled = false; }
  });
}
async function complete(path, data, message) {
  await api(path, data);
  modal.close();
  if (message) notice(message);
  await refresh(true);
}
function deviceOption(device) {
  return { id: device.id, name: device.name + ' · ' + (device.online ? 'Online' : 'Offline') +
    ' · ID ' + device.id.slice(0, 8) };
}
function selectTeamDevice(teamId) {
  const { user, devices } = state.data;
  const team = (user.role === 'admin' ? state.data.accounts : state.data.teams).find(account => account.id === teamId);
  if (!team) throw new Error('Estabelecimento não encontrado.');
  const current = devices.find(device => device.team === teamId);
  if (current) {
    showDialog('Maquininha vinculada', team.name, '<p>' + esc(current.name) + '</p><div class="result-actions">' +
      (user.role === 'admin' ? button('Desvincular maquininha', 'device-unlink', null, 'danger-ghost', current.id) : '') + '</div>');
    return;
  }
  const available = devices.filter(device => !device.team).map(deviceOption);
  if (!available.length) throw new Error('Nenhuma maquininha disponível. O gestor pode cadastrar ou desvincular uma.');
  showDialog('Vincular maquininha', team.name, form(select('Maquininha disponível', 'device', available), 'Vincular'));
  onForm(data => complete(user.role === 'admin' ? '/admin/devices/' + data.device + '/link' : '/teams/' + teamId + '/device',
    user.role === 'admin' ? { team: teamId } : data, 'Maquininha vinculada.'));
}
function credentials(title, data) {
  const values = [['ID da maquininha', data.id], ['Chave para o ESP32', data.key], ['Código para o estabelecimento', data.pairing]];
  showDialog(title, data.pairing || data.key ? 'Guarde estes dados antes de fechar.' :
    'Cadastro salvo. A maquininha está disponível na lista para vincular.', values.filter(([, value]) => value).map(([label, value]) =>
    '<div class="credential"><label>' + label + '<input readonly value="' + esc(value) + '"></label>' +
    button('Copiar', 'copy', null, 'ghost', value) + '</div>').join(''));
}
function saleDialog(team) {
  const keys = ['1','2','3','4','5','6','7','8','9','00','0','del'];
  let value = '';
  showDialog('Efetuar venda', team.name, '<div class="key-value"><span>VALOR DA VENDA</span><output>' + money(0) + '</output></div><div class="keypad">' +
    keys.map(key => '<button type="button" data-key="' + key + '" aria-label="' + (key === 'del' ? 'Apagar' : key) + '">' +
    (key === 'del' ? icon('backspace') : key) + '</button>').join('') + '</div><p class="form-error" role="alert"></p><div class="dialog-buttons">' +
    '<button class="btn ghost" data-method="pix">' + icon('pix') + 'Gerar Pix</button><button class="btn primary" data-method="rfid" ' +
    (team.device?.online ? '' : 'disabled') + '>' + icon('card') + 'Cobrar no cartão</button></div>' +
    (team.device?.online ? '' : '<p class="field-help">Vincule uma maquininha online para aceitar cartão.</p>'));
  modal.querySelector('.keypad').addEventListener('click', e => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (!key) return;
    if (key === 'del') value = value.slice(0, -1);
    else value = (value + key).replace(/^0+/, '').slice(0, 12);
    modal.querySelector('output').textContent = money(Number(value));
  });
  for (const b of modal.querySelectorAll('[data-method]')) b.addEventListener('click', async () => {
    const buttons = Array.from(modal.querySelectorAll('[data-method]')).filter(item => !item.disabled);
    buttons.forEach(item => { item.disabled = true; });
    try { await complete('/teams/' + team.id + '/sales', { method: b.dataset.method, amount: Number(value) }, 'Cobrança criada.'); }
    catch (error) { modal.querySelector('.form-error').textContent = error.message; }
    finally { buttons.forEach(item => { item.disabled = false; }); }
  });
}
function stopCamera() {
  cancelAnimationFrame(scanFrame);
  camera?.getTracks().forEach(track => track.stop());
  camera = null;
}
modal.addEventListener('close', stopCamera);
function pixId(value) {
  const match = /^(?:BANCOVIRTUAL|BANCOFEIRA):([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(value.trim());
  if (!match) throw new Error('Use um código Pix do Banco Virtual.');
  return match[1].toLowerCase();
}
function pixAccount(id) {
  const account = id ? state.data.teams.find(team => team.id === id) : state.data.user;
  if (!account) throw new Error('A conta de origem não está disponível.');
  return account;
}
function pixOriginLabel(account) {
  const label = account.cnpj ? 'Estabelecimento' : account.role === 'admin' ? 'Conta do banco' : 'Conta pessoal';
  return label + ' · ' + account.name;
}
function paymentAction(path, payload, title) {
  onForm(async (_, target) => {
    const feedback = target.querySelector('.payment-feedback');
    feedback.replaceChildren();
    try {
      const result = await api(path, payload);
      if (modal.open && target.isConnected) {
        showDialog(title, 'Movimentação registrada no Banco Virtual.',
          '<div class="payment-result success" role="status">' + icon('check') + '<strong>' + esc(title) + '</strong></div>' +
          '<div class="result-actions">' + button('Ver comprovante', 'receipt', 'history', 'primary', result.id) +
          button('Fechar', 'close', null, 'ghost') + '</div>');
      }
      await refresh(true);
    } catch (error) {
      feedback.innerHTML = '<div class="payment-result failure" role="alert">' + icon('close') +
        '<strong>Operação não confirmada</strong><p>' + esc(error.status ? error.message : 'Confira a conexão e tente novamente.') + '</p></div>';
    }
  });
}
function confirmPix(account, name, amount, path, payload) {
  showDialog('Confirmar Pix', 'Confira a origem, o destinatário e o valor.', form(
    '<div class="key-value"><span>PARA ' + esc(name) + '</span><strong>' + money(amount) + '</strong></div>' +
    '<p class="field-help">Sai de ' + esc(pixOriginLabel(account)) + '</p><div class="payment-feedback"></div>', 'Confirmar Pix'));
  paymentAction(path, { ...payload, source: account.id }, 'Pix enviado');
}
function sendPixDialog(account) {
  showDialog('Enviar Pix', 'Sai de ' + pixOriginLabel(account), form(
    input('Chave Pix', 'key', 'placeholder="Cole ou digite a chave" maxlength="150" autocomplete="off" autocapitalize="none"') +
    '<div class="recipient-preview" role="status"></div>' +
    input('Valor em reais', 'value', 'inputmode="decimal" placeholder="25,00"'), 'Revisar Pix'));
  const target = modal.querySelector('form');
  const field = target.elements.key;
  const preview = target.querySelector('.recipient-preview');
  const review = target.querySelector('button');
  let timer, revision = 0, match;
  review.disabled = true;
  field.addEventListener('input', () => {
    clearTimeout(timer);
    const version = ++revision;
    const key = field.value.trim();
    match = null;
    review.disabled = true;
    preview.textContent = '';
    if (key.length < 3) return;
    timer = setTimeout(async () => {
      if (!modal.open || !target.isConnected) return;
      preview.textContent = 'Consultando chave…';
      try {
        const recipient = await api('/pix/recipient/auto/' + encodeURIComponent(key));
        if (version !== revision || !modal.open || !target.isConnected) return;
        if (recipient.id === account.id) throw new Error('Escolha uma conta diferente da conta de origem.');
        const detail = recipient.cnpj ? 'CNPJ ' + recipient.cnpj : '@' + recipient.username;
        match = { key, recipient, detail };
        preview.innerHTML = '<strong>' + esc(recipient.name) + '</strong><small>' + esc(detail) + ' · Banco Virtual</small>';
        review.disabled = false;
      } catch (error) {
        if (version === revision && target.isConnected) preview.textContent = error.message;
      }
    }, 350);
  });
  onForm(async (data, target) => {
    const amount = cents(data.value);
    if (amount <= 0) throw new Error('Informe um valor maior que zero.');
    if (!match || match.key !== data.key.trim()) throw new Error('Consulte a chave antes de revisar o Pix.');
    if (!modal.open || !target.isConnected) return;
    confirmPix(account, match.recipient.name + ' · ' + match.detail, amount, '/pix/transfer',
      { recipient: match.recipient.id, key: match.key, amount, request: requestId() });
  });
}
const keyLabels = { username: 'Nome de usuário', cnpj: 'CNPJ fictício', random: 'Chave aleatória', email: 'E-mail fictício', phone: 'Celular fictício', cpf: 'CPF fictício' };
async function keysDialog(account) {
  const { keys } = await api('/pix/keys?source=' + encodeURIComponent(account.id));
  showDialog('Minhas chaves Pix', pixOriginLabel(account), '<ul class="key-list">' + keys.map(key =>
    '<li><div><strong>' + keyLabels[key.type] + '</strong><code>' + esc(key.value) + '</code></div><div class="key-actions">' +
    button('Copiar', 'copy', null, 'ghost', key.value) + (key.id ? '<button type="button" class="btn danger-ghost" data-remove-key="' +
      esc(key.id) + '">Remover</button>' : '') + '</div></li>').join('') +
    '</ul><button type="button" class="btn primary" data-new-key>' + icon('plus') + 'Cadastrar chave Pix</button>');
  modal.querySelector('[data-new-key]').addEventListener('click', () => createKeyDialog(account));
  for (const remove of modal.querySelectorAll('[data-remove-key]')) remove.addEventListener('click', () => {
    const key = keys.find(item => item.id === remove.dataset.removeKey);
    showDialog('Remover chave Pix', key.value, form('', 'Remover chave', 'danger'));
    onForm(async () => {
      await api('/pix/keys/' + key.id + '/remove', { source: account.id });
      await keysDialog(account);
      notice('Chave removida.');
    });
  });
}
function createKeyDialog(account) {
  const types = (account.cnpj ? ['random', 'email', 'phone'] : ['random', 'email', 'phone', 'cpf'])
    .map(id => ({ id, name: keyLabels[id] }));
  showDialog('Cadastrar chave Pix', 'Use dados fictícios nesta simulação.', form(
    select('Tipo de chave', 'type', types, 'random') +
    '<div data-key-value hidden>' + input('Valor da chave', 'value', 'maxlength="150" autocomplete="off" autocapitalize="none"', false) + '</div>' +
    '<p class="field-help" data-key-help></p>', 'Cadastrar chave'));
  const target = modal.querySelector('form');
  const examples = { email: 'aluno@example.com', phone: '+55 (11) 90000-0000', cpf: '000.000.000-00' };
  function updateKeyField() {
    const type = target.elements.type.value;
    const generated = !examples[type];
    target.querySelector('[data-key-value]').hidden = generated;
    target.elements.value.required = !generated;
    target.elements.value.placeholder = examples[type] || '';
    target.querySelector('[data-key-help]').textContent = type === 'random' ? 'O banco gera uma chave exclusiva para esta conta.' : '';
  }
  target.elements.type.addEventListener('change', updateKeyField);
  updateKeyField();
  onForm(async data => {
    await api('/pix/keys', { ...data, source: account.id });
    await keysDialog(account);
    notice('Chave cadastrada.');
  });
}
function receiptParty(name, role, username, cnpj) {
  const label = role === 'team' ? 'Estabelecimento' : role === 'admin' ? 'Conta do banco' : role === 'student' ? 'Conta pessoal' : 'Banco Virtual';
  return esc(name || 'Banco Virtual') + '<small>' + label + (cnpj ? ' · CNPJ ' + esc(cnpj) : username ? ' · @' + esc(username) : '') + '</small>';
}
async function receiptDialog(id) {
  const entry = await api('/activity/' + id);
  const title = entry.method === 'refund' ? 'Comprovante de devolução' : 'Comprovante';
  const related = entry.refundId ? button('Ver devolução', 'receipt', 'history', 'ghost', entry.refundId) :
    entry.originalId ? button('Ver movimentação original', 'receipt', 'history', 'ghost', entry.originalId) : '';
  const refund = entry.canRefund ? button(entry.method === 'rfid' ? 'Estornar venda' : 'Devolver valor', 'refund', null, 'danger-ghost', entry.id) : '';
  showDialog(title, 'Banco Virtual · Operação simulada', '<div class="key-value"><span>' + methods[entry.method] +
    '</span><strong>' + money(entry.amount) + '</strong></div><dl class="receipt-details">' +
    (entry.description ? '<dt>Descrição</dt><dd>' + esc(entry.description) + '</dd>' : '') +
    '<dt>Status</dt><dd>' + (entry.refundId ? 'Valor devolvido' : 'Concluída') + '</dd>' +
    '<dt>Data e hora</dt><dd>' + date(entry.created) + '</dd>' +
    '<dt>Origem</dt><dd>' + receiptParty(entry.fromName, entry.fromRole, entry.fromUser, entry.fromCnpj) + '</dd>' +
    '<dt>Destino</dt><dd>' + receiptParty(entry.toName, entry.toRole, entry.toUser, entry.toCnpj) + '</dd>' +
    '<dt>ID da transação</dt><dd><code>' + esc(entry.id) + '</code></dd></dl>' +
    '<div class="result-actions">' + refund + related + button('Copiar ID', 'copy', null, 'ghost', entry.id) + '</div>');
  return entry;
}
async function refundDialog(id) {
  const entry = await api('/activity/' + id);
  if (!entry.canRefund) throw new Error('Esta movimentação não está disponível para devolução.');
  const label = entry.method === 'rfid' ? 'Estornar venda' : 'Devolver valor';
  showDialog(label, 'O valor integral voltará para a conta de origem.', form(
    '<div class="key-value"><span>PARA ' + esc(entry.fromName) + '</span><strong>' + money(entry.amount) + '</strong></div>' +
    '<p class="field-help">Sai do saldo de ' + esc(entry.toName) + '.</p><div class="payment-feedback"></div>',
    'Confirmar devolução', 'danger'));
  paymentAction('/activity/' + id + '/refund', {}, 'Valor devolvido');
}
function newChargeDialog(accounts) {
  const teams = accounts.filter(account => account.role === 'team');
  if (!teams.length) throw new Error('Cadastre um estabelecimento para lançar uma cobrança.');
  const request = requestId();
  showDialog('Nova cobrança', 'O pagamento será recebido na conta do banco.', form(
    select('Estabelecimento', 'team', [{ id: 'all', name: 'Todos os estabelecimentos' }, ...teams]) +
    input('Descrição da cobrança', 'description', 'maxlength="80" placeholder="Ex. Taxa de maquininha, IPTU ou aluguel"') +
    select('Forma de cálculo', 'type', [{ id: 'fixed', name: 'Valor fixo' }, { id: 'percent', name: 'Percentual do saldo' }], 'fixed') +
    input('<span data-charge-label>Valor em reais</span>', 'value', 'inputmode="decimal" placeholder="25,00"') +
    '<p class="field-help" data-charge-help></p>', 'Lançar cobrança'));
  const target = modal.querySelector('form');
  function update() {
    const percent = target.elements.type.value === 'percent';
    target.querySelector('[data-charge-label]').textContent = percent ? 'Percentual (%)' : 'Valor em reais';
    target.elements.value.placeholder = percent ? 'Ex. 5,00' : '25,00';
    target.querySelector('[data-charge-help]').textContent = percent
      ? 'O valor é calculado sobre o saldo disponível no lançamento. Resultados de R$ 0,00 são ignorados.'
      : 'O valor é aplicado integralmente a cada estabelecimento selecionado.';
  }
  target.elements.type.addEventListener('change', update);
  update();
  onForm(async data => {
    const result = await api('/bank/charges', { team: data.team, type: data.type, description: data.description,
      value: cents(data.value), request });
    modal.close();
    notice(result.count === 1 ? 'Cobrança lançada.' : result.count + ' cobranças lançadas.');
    await refresh(true);
  });
}
function payChargeDialog(id, teams) {
  const team = teams.find(account => account.charges?.some(charge => charge.id === id));
  const charge = team?.charges.find(charge => charge.id === id);
  if (!charge) throw new Error('Esta cobrança não está mais disponível.');
  showDialog('Pagar cobrança do banco', charge.description, form(
    '<div class="key-value"><span>PARA CONTA DO BANCO</span><strong>' + money(charge.amount) + '</strong></div>' +
    '<p class="field-help">Sai do saldo de ' + esc(team.name) + '.</p><div class="payment-feedback"></div>', 'Confirmar pagamento'));
  paymentAction('/bank/charges/' + id + '/pay', {}, 'Cobrança paga');
}
async function previewPix(value, account) {
  stopCamera();
  const target = modal.querySelector('form');
  const id = pixId(value);
  const data = await api('/pix/' + id);
  if (modal.open && target?.isConnected) confirmPix(account, data.name, data.amount, '/pix/' + id, {});
}
function pixDialog(account) {
  showDialog('Pagar cobrança Pix', 'Sai de ' + pixOriginLabel(account), '<div class="scan-area"><video playsinline muted hidden></video>' +
    button('Abrir câmera', 'camera', 'pix', 'ghost', account.cnpj ? account.id : '') + '<label class="file-label">Selecionar foto do QR Code<input type="file" accept="image/*" id="qr-file"></label></div>' +
    form(input('Código Pix', 'code', 'placeholder="BANCOVIRTUAL:…" autocomplete="off"'), 'Consultar cobrança'));
  onForm(data => previewPix(data.code, account));
  modal.querySelector('#qr-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const errorBox = modal.querySelector('.form-error');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = window.jsQR(pixels.data, pixels.width, pixels.height);
      if (!found) throw new Error('Não foi possível ler o QR Code da foto.');
      if (modal.open && e.target.isConnected) await previewPix(found.data, account);
    } catch (e) { errorBox.textContent = e.message; }
    finally { bitmap?.close(); }
  });
}
async function startCamera(b) {
  const account = pixAccount(b.dataset.id);
  const video = modal.querySelector('video');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('A câmera precisa de HTTPS no celular. Você também pode usar uma foto ou colar o código.');
  b.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    if (!modal.open || !video.isConnected) { stream.getTracks().forEach(track => track.stop()); return; }
    camera = stream;
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let previous = 0;
    function scan(now) {
      if (now - previous > 160 && video.videoWidth) {
        previous = now;
        canvas.width = Math.min(640, video.videoWidth);
        canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = window.jsQR(frame.data, frame.width, frame.height);
        if (found) {
          previewPix(found.data, account).catch(e => { video.hidden = true; b.disabled = false; notice(e.message, true); });
          return;
        }
      }
      scanFrame = requestAnimationFrame(scan);
    }
    scanFrame = requestAnimationFrame(scan);
  } catch {
    stopCamera();
    video.hidden = true;
    b.disabled = false;
    throw new Error('Não foi possível abrir a câmera. Confira a permissão ou use uma foto.');
  }
}

document.addEventListener('submit', async e => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const form = e.target, submit = form.querySelector('button'), error = form.querySelector('.form-error');
  submit.disabled = true;
  error.textContent = '';
  try {
    await api('/login', Object.fromEntries(new FormData(form)));
    state.page = 'overview';
    state.balance = true;
    await refresh(true);
  } catch (e) { error.textContent = e.message; }
  finally { submit.disabled = false; }
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-action]');
  if (!b || !state.data) return;
  const { action, id } = b.dataset;
  const { accounts = [], members = [], teams = [], devices } = state.data;
  try {
    switch (action) {
      case 'page': state.page = id; drawPage(); window.scrollTo(0, 0); break;
      case 'balance': state.balance = !state.balance; drawPage(); break;
      case 'close': modal.close(); break;
      case 'logout':
        await api('/logout', {});
        ++generation;
        state.running = false;
        events?.close();
        events = null;
        state.data = null;
        render();
        break;
      case 'student': {
        const student = accounts.find(x => x.id === id);
        showDialog(student ? 'Editar aluno' : 'Cadastrar aluno',
          student ? 'Deixe a senha em branco para manter a atual.' : 'Crie o acesso que o aluno usará no celular.', form(
            input('Nome', 'name', 'maxlength="70" value="' + esc(student?.name) + '"') +
            input('Usuário', 'username', 'minlength="3" maxlength="40" autocapitalize="none" value="' + esc(student?.username) + '"') +
            input(student ? 'Nova senha (opcional)' : 'Senha inicial', 'password',
              'type="password" minlength="8" maxlength="128" autocomplete="new-password"', !student),
            student ? 'Salvar alterações' : 'Criar conta'));
        const path = student ? '/admin/students/' + student.id + '/edit' : '/admin/students';
        onForm(data => complete(path, data, student ? 'Aluno atualizado.' : 'Conta criada.'));
        break;
      }
      case 'team': {
        const team = accounts.find(x => x.id === id);
        const assigned = new Map(members.map(m => [m.student, m.team]));
        const eligible = accounts.filter(x => x.role === 'student' && (!assigned.has(x.id) || assigned.get(x.id) === team?.id));
        if (!eligible.length) throw new Error('Cadastre pelo menos um aluno que ainda não tenha estabelecimento.');
        showDialog(team ? 'Editar estabelecimento' : 'Cadastrar estabelecimento', 'Escolha um ou mais alunos para operar esta conta.', form(
          input('Nome do estabelecimento', 'name', 'maxlength="70" value="' + esc(team?.name) + '"') +
          input('CNPJ fictício', 'cnpj', 'maxlength="18" placeholder="00.000.000/0001-00" value="' + esc(team?.cnpj) + '"') +
          '<fieldset class="member-picker"><legend>Alunos autorizados</legend><div class="member-options">' +
          eligible.map(x => '<label><input type="checkbox" name="member" value="' + esc(x.id) + '"' +
            (assigned.has(x.id) ? ' checked' : '') + '><span>' +
            esc(x.name) + ' <small>@' + esc(x.username) + '</small></span></label>').join('') +
          '</div></fieldset>', team ? 'Salvar alterações' : 'Criar estabelecimento'));
        const path = team ? '/admin/teams/' + team.id + '/edit' : '/admin/teams';
        onForm((data, target) => {
          const members = new FormData(target).getAll('member');
          if (!members.length) throw new Error('Selecione pelo menos um aluno.');
          return complete(path, { name: data.name, cnpj: data.cnpj, members },
            team ? 'Estabelecimento atualizado.' : 'Estabelecimento cadastrado.');
        });
        break;
      }
      case 'credit': {
        if (!accounts.length) throw new Error('Cadastre um aluno ou um estabelecimento para liberar saldo.');
        const request = requestId();
        const options = [{ id: 'all', name: 'Todas as contas (alunos e estabelecimentos)' },
          ...accounts.map(x => ({ id: x.id, name: x.name + (x.role === 'team' ? ' · Estabelecimento' : ' · Aluno') }))];
        showDialog('Liberar saldo', 'O valor informado será creditado em cada conta selecionada.', form(
          select('Conta de destino', 'account', options, id) +
          input('Valor por conta', 'value', 'inputmode="decimal" placeholder="25,00"') +
          '<p class="field-help" data-credit-summary></p>', 'Confirmar crédito'));
        const target = modal.querySelector('form');
        target.addEventListener('input', () => {
          const summary = target.querySelector('[data-credit-summary]');
          summary.textContent = '';
          if (target.elements.account.value !== 'all') return;
          try { summary.textContent = accounts.length + ' contas · Total de ' + money(cents(target.elements.value.value) * accounts.length); }
          catch { summary.textContent = accounts.length + ' contas ativas.'; }
        });
        onForm(async data => {
          const result = await api('/admin/credit', { account: data.account, amount: cents(data.value), request });
          modal.close();
          notice(data.account === 'all' ? 'Saldo liberado em ' + result.count + ' conta(s).' : 'Saldo liberado.');
          await refresh(true);
        });
        break;
      }
      case 'device':
        showDialog('Registrar maquininha', 'Cole o ID e a chave exibidos na página de configuração do ESP32.', form(
          input('Nome da maquininha', 'name', 'maxlength="50" placeholder="Ex. Maquininha 01"') +
          input('ID da maquininha', 'deviceId', 'maxlength="36" placeholder="Ex. 5831" autocapitalize="none" autocomplete="off"') +
          input('Chave da maquininha', 'deviceKey', 'type="password" minlength="64" maxlength="64" autocapitalize="none" autocomplete="new-password"'),
          'Registrar'));
        onForm(async data => {
          const { id } = await api('/admin/devices', data);
          credentials('Maquininha registrada', { id });
          await refresh(true);
        });
        break;
      case 'reset':
        showDialog('Gerar novo código', 'A maquininha será desvinculada do estabelecimento atual e a cobrança por cartão em aberto será cancelada.', form('', 'Gerar código'));
        onForm(async () => { const result = await api('/admin/devices/' + id + '/reset', {}); credentials('Novo código de vínculo', result); await refresh(true); });
        break;
      case 'delete-account': {
        const account = accounts.find(x => x.id === id);
        if (!account) break;
        const student = account.role === 'student';
        const label = student ? 'Excluir aluno' : 'Excluir estabelecimento';
        const consequence = student
          ? 'O acesso ao banco será encerrado e o cartão e o vínculo com o estabelecimento serão liberados.'
          : 'As cobranças em aberto serão canceladas. A maquininha e os alunos ficarão disponíveis para outros vínculos.';
        const membership = members.find(m => m.student === id);
        const lastOperator = membership && !members.some(m => m.team === membership.team && m.student !== id);
        const saleNotice = lastOperator ? '<p>Como este é o último aluno autorizado, as cobranças em aberto do estabelecimento serão canceladas.</p>' : '';
        showDialog(label, account.name, form('<p>' + consequence + '</p>' + saleNotice +
          '<p>O saldo ficará indisponível e o histórico será preservado.</p>', label, 'danger'));
        onForm(() => complete('/admin/' + (student ? 'students' : 'teams') + '/' + id + '/delete', {},
          student ? 'Aluno excluído.' : 'Estabelecimento excluído.'));
        break;
      }
      case 'unlink':
        showDialog('Desvincular cartão', 'O aluno poderá vincular outro cartão pelo banco.', form('', 'Desvincular'));
        onForm(() => complete('/admin/students/' + id + '/unlink', {}, 'Cartão desvinculado.'));
        break;
      case 'pair':
        selectTeamDevice(id);
        break;
      case 'device-link': {
        const device = devices.find(item => item.id === id);
        if (!device) break;
        const available = accounts.filter(account => account.role === 'team' && !devices.some(item => item.team === account.id));
        if (!available.length) throw new Error('Nenhum estabelecimento sem maquininha está disponível.');
        showDialog('Vincular maquininha', device.name, form(select('Estabelecimento', 'team', available), 'Vincular'));
        onForm(data => complete('/admin/devices/' + id + '/link', data, 'Maquininha vinculada.'));
        break;
      }
      case 'device-unlink': {
        const device = devices.find(item => item.id === id);
        if (!device) break;
        showDialog('Desvincular maquininha', device.name,
          form('<p>O terminal ficará disponível para outro estabelecimento. Cobranças no cartão e vínculos de cartão em andamento neste terminal serão cancelados.</p>', 'Desvincular', 'danger'));
        onForm(() => complete('/admin/devices/' + id + '/unlink', {}, 'Maquininha desvinculada.'));
        break;
      }
      case 'device-name': {
        const device = devices.find(item => item.id === id);
        if (!device) break;
        showDialog('Renomear maquininha', 'Escolha um nome fácil de reconhecer na lista.', form(
          input('Nome da maquininha', 'name', 'maxlength="50" value="' + esc(device.name) + '"'), 'Salvar nome'));
        onForm(data => complete('/admin/devices/' + id + '/edit', data, 'Nome atualizado.'));
        break;
      }
      case 'sale': saleDialog(teams.find(x => x.id === id)); break;
      case 'sale-pix':
      case 'sale-cancel':
        b.disabled = true;
        try { await complete('/teams/' + teams[0].id + '/sales/' + id + '/' + (action === 'sale-pix' ? 'pix' : 'cancel'), {}, action === 'sale-pix' ? 'QR Code gerado.' : 'Cobrança cancelada.'); }
        finally { b.disabled = false; }
        break;
      case 'card': {
        if (state.data.card?.status === 'pending') throw new Error('Já existe um vínculo em andamento.');
        const online = devices.filter(x => x.online && x.team);
        if (!online.length) throw new Error('Nenhuma maquininha vinculada está online.');
        showDialog('Vincular cartão', 'Escolha o terminal perto de você. Depois, aproxime seu cartão em até 1 minuto.', form(select('Maquininha', 'device', online), 'Iniciar vínculo'));
        onForm(data => complete('/card', data, 'Aproxime seu cartão.'));
        break;
      }
      case 'card-cancel': await complete('/card/' + id + '/cancel', {}, 'Vínculo cancelado.'); break;
      case 'pix-send': sendPixDialog(pixAccount(id)); break;
      case 'pix': pixDialog(pixAccount(id)); break;
      case 'pix-keys': await keysDialog(pixAccount(id)); break;
      case 'receipt': await receiptDialog(id); break;
      case 'refund': await refundDialog(id); break;
      case 'charge-new': newChargeDialog(accounts); break;
      case 'charge-pay': payChargeDialog(id, teams); break;
      case 'charge-cancel': {
        const charge = state.data.charges.find(item => item.id === id);
        if (!charge) break;
        showDialog('Cancelar cobrança', charge.description, form('', 'Cancelar cobrança', 'danger'));
        onForm(() => complete('/bank/charges/' + id + '/cancel', {}, 'Cobrança cancelada.'));
        break;
      }
      case 'camera': await startCamera(b); break;
      case 'copy':
        if (navigator.clipboard) await navigator.clipboard.writeText(id);
        else {
          const field = document.createElement('textarea');
          field.value = id;
          (modal.open ? modal : document.body).append(field);
          field.select();
          if (!document.execCommand('copy')) { field.remove(); throw new Error('O navegador bloqueou a cópia.'); }
          field.remove();
        }
        notice('Copiado.');
        break;
    }
  } catch (error) { notice(error.message, true); }
});

refresh(true);
setInterval(() => { if (state.data && !document.hidden && events?.readyState !== EventSource.OPEN) refresh(); }, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.data) refresh(); });
