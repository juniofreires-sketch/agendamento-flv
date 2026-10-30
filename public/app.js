const $ = s => document.querySelector(s);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api = async (url, method='GET', body) => {
  const options = {method, credentials:'same-origin', headers:{}};
  if (body !== undefined) { options.headers['content-type']='application/json'; options.body=JSON.stringify(body); }
  const response = await fetch(url,options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
  return data;
};
const state = {meta:null,user:null,view:'dashboard',authMode:'login',bookTab:'active',dashFrom:'',dashTo:'',dashSupplier:'',bookFrom:'',bookTo:'',bookSupplier:'',slotDay:'',bookings:[],pending:[],historyFrom:'',historyTo:'',historySupplier:'',historyStatus:'',historySearched:false,historyBookings:[]};
const dateBR = day => day ? day.split('-').reverse().join('/') : '—';
const shortDate = day => new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'2-digit',month:'long'}).format(new Date(day+'T12:00:00Z'));
const formatNum = n => new Intl.NumberFormat('pt-BR').format(n || 0);
const formatWeight = n => new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2}).format(n || 0);
const today = () => state.meta?.today || new Date().toISOString().slice(0,10);
const dateOffset = (day, n) => {const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const firstOfMonth = day => day.slice(0,7)+'-01';
const lastOfMonth = day => {const d=new Date(day+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+1,0);return d.toISOString().slice(0,10)};
const nextOpenDay = day => {let x=day;while(new Date(x+'T12:00:00Z').getUTCDay()===0)x=dateOffset(x,1);return x};
const toast = (message,error=false) => {const el=$('#toast');el.textContent=message;el.className='toast show'+(error?' error':'');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='toast',4500)};
const submitButton = (form, busy) => {const button=form.querySelector('button[type="submit"]');if(button){button.disabled=busy;button.dataset.text ||= button.textContent;button.textContent=busy?'Aguarde...':button.dataset.text}};
const supplierOptions = (selected='',includeAll=false) => (includeAll?'<option value="">Todos os fornecedores</option>':'<option value="">Selecione um fornecedor</option>')+state.meta.suppliers.map(s=>'<option value="'+s.id+'"'+(String(selected)===String(s.id)?' selected':'')+'>'+esc(s.name)+'</option>').join('');
const optionList = arr => '<option value="">Selecione</option>'+arr.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('');
function supplierCombo(id){
  return '<div class="field"><label for="'+id+'Trigger">Fornecedor *</label><div class="supplier-combo" data-supplier-combo><input type="hidden" id="'+id+'Value" name="supplier_id"><button id="'+id+'Trigger" class="supplier-trigger" type="button" data-combo-trigger aria-haspopup="listbox" aria-expanded="false"><span data-combo-label>Selecione um fornecedor</span><span aria-hidden="true">⌄</span></button><div class="supplier-popover" data-combo-panel hidden><input type="search" data-combo-search aria-label="Pesquisar fornecedor" placeholder="Pesquisar fornecedor..."><div class="supplier-results" data-combo-results role="listbox"></div></div></div></div>';
}
function renderComboResults(combo,query=''){
  const value=query.trim().toLocaleLowerCase('pt-BR');
  const matches=state.meta.suppliers.filter(s=>s.name.toLocaleLowerCase('pt-BR').includes(value));
  const list=combo.querySelector('[data-combo-results]');
  list.innerHTML=matches.length?matches.map(s=>'<button type="button" role="option" data-combo-option="'+s.id+'">'+esc(s.name)+'</button>').join(''):'<div class="supplier-empty">Nenhum fornecedor encontrado.</div>';
}
function closeSupplierCombos(){
  document.querySelectorAll('[data-supplier-combo]').forEach(combo=>{
    combo.querySelector('[data-combo-panel]').hidden=true;
    combo.querySelector('[data-combo-trigger]').setAttribute('aria-expanded','false');
  });
}
function openSupplierCombo(combo){
  closeSupplierCombos();
  const panel=combo.querySelector('[data-combo-panel]');
  panel.hidden=false;
  combo.querySelector('[data-combo-trigger]').setAttribute('aria-expanded','true');
  const search=combo.querySelector('[data-combo-search]');
  search.value='';
  renderComboResults(combo);
  search.focus();
}

function showAuth(mode='login'){
  state.authMode=mode;
  $('#appShell').classList.add('hidden');$('#authScreen').classList.remove('hidden');
  const boot=state.meta.bootstrap;
  let form='';
  if(boot){
    form='<p class="eyebrow">CONFIGURAÇÃO INICIAL</p><h2>Crie o acesso administrador</h2><p class="subtext">Este primeiro acesso controla aprovações e o cadastro de fornecedores no teste local.</p><form id="bootstrapForm"><div class="field"><label for="bootName">Seu nome</label><input id="bootName" name="name" required autocomplete="name"></div><div class="field"><label for="bootEmail">Email</label><input id="bootEmail" name="email" type="email" required autocomplete="email"></div><div class="field"><label for="bootPassword">Senha</label><input id="bootPassword" name="password" type="password" minlength="10" required autocomplete="new-password"><small>Mínimo de 10 caracteres.</small></div><button class="btn btn-primary btn-full" type="submit">Criar administrador</button></form>';
  } else {
    form='<p class="eyebrow">BEM-VINDO AO PORTAL</p><h2>'+(mode==='login'?'Acesse sua conta':'Crie sua conta')+'</h2><p class="subtext">'+(mode==='login'?'Entre para acompanhar seus agendamentos e emitir a senha de entrega.':'Escolha sua empresa na lista. O acesso será liberado após aprovação.')+'</p><div class="auth-tabs"><button type="button" data-auth="login" class="'+(mode==='login'?'active':'')+'">Entrar</button><button type="button" data-auth="register" class="'+(mode==='register'?'active':'')+'">Cadastrar</button></div>';
    if(mode==='login')form+='<form id="loginForm"><div class="field"><label for="loginEmail">Email</label><input id="loginEmail" name="email" type="email" placeholder="seu@email.com" required autocomplete="email"></div><div class="field"><label for="loginPassword">Senha</label><input id="loginPassword" name="password" type="password" placeholder="Sua senha" required autocomplete="current-password"></div><button class="btn btn-primary btn-full" type="submit">Entrar no portal →</button></form><p class="auth-note">Seu acesso mostra apenas os dados do seu fornecedor.</p>';
    else form+='<form id="registerForm"><div class="field"><label for="regName">Seu nome</label><input id="regName" name="name" required autocomplete="name"></div><div class="field"><label for="regEmail">Email de acesso</label><input id="regEmail" name="email" type="email" required autocomplete="email"></div>'+supplierCombo('regSupplier')+'<div class="field"><label for="regPassword">Senha</label><input id="regPassword" name="password" type="password" minlength="10" required autocomplete="new-password"><small>Mínimo de 10 caracteres.</small></div><button class="btn btn-primary btn-full" type="submit">Solicitar cadastro →</button></form><p class="auth-note">A equipe avaliará o cadastro e liberará o acesso após aprovação do administrador.</p>';
  }
  $('#authContent').innerHTML='<div class="auth-inner">'+form+'</div>';
}
function showRegistrationReceived(message){
  state.authMode='login';
  $('#appShell').classList.add('hidden');$('#authScreen').classList.remove('hidden');
  $('#authContent').innerHTML='<div class="auth-inner"><div class="registration-icon" aria-hidden="true">✓</div><p class="eyebrow">CADASTRO RECEBIDO</p><h2>Solicitação em análise</h2><p class="subtext">'+esc(message)+'</p><div class="info-panel registration-panel"><strong>Próximo passo</strong><p>A equipe verificará seu vínculo com o fornecedor. Você poderá entrar somente depois que um administrador aprovar o cadastro.</p></div><button class="btn btn-primary btn-full" type="button" data-auth="login">Voltar para entrar</button></div>';
}
function showApp(){
  $('#authScreen').classList.add('hidden');$('#appShell').classList.remove('hidden');
  $('#userAvatar').textContent=(state.user.name||'F').slice(0,1).toUpperCase();
  $('#todayLabel').textContent=dateBR(today());
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hidden',state.user.role!=='admin'));
  if(!state.dashFrom){state.dashFrom=firstOfMonth(today());state.dashTo=lastOfMonth(today());state.bookFrom=dateOffset(today(),-90);state.bookTo=dateOffset(today(),90);state.historyFrom=dateOffset(today(),-365);state.historyTo=today();state.slotDay=nextOpenDay(state.meta.current_time > '10:00' ? dateOffset(today(),1) : today())}
  navigate(state.view);
}
function navigate(view){
  if(view==='admin'&&state.user.role!=='admin')view='dashboard';
  state.view=view;
  const titles={dashboard:'Dashboard',schedule:'Novo agendamento',bookings:'Agendamentos',admin:'Administração'};
  $('#pageTitle').textContent=titles[view];$('#crumb').textContent=titles[view].toUpperCase();
  document.querySelectorAll('.nav-link[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('#sidebar').classList.remove('open');$('#mobileOverlay').classList.remove('show');
  if(view==='dashboard')renderDashboard();
  if(view==='schedule')renderSchedule();
  if(view==='bookings')renderBookings();
  if(view==='admin')renderAdmin();
}
const pageHead=(kicker,title,description,action='')=>'<div class="page-head"><div><p class="eyebrow">'+kicker+'</p><h1>'+title+'</h1><p>'+description+'</p></div><div class="page-actions">'+action+'</div></div>';
function bookingTable(rows,actions=true){
  if(!rows.length)return '<div class="empty-state"><span class="empty-icon">▤</span><strong>Nenhum agendamento encontrado</strong><span>Altere o período ou crie um novo agendamento.</span></div>';
  return '<div class="table-wrap"><table class="data-table"><thead><tr><th>Senha</th><th>Data e horário</th><th>Fornecedor</th><th>Carga</th><th>Situação</th><th></th></tr></thead><tbody>'+rows.map(b=>'<tr><td><span class="cell-title">#'+String(b.id).padStart(3,'0')+'</span><span class="cell-sub">'+esc(b.vehicle_type)+'</span></td><td><span class="cell-title">'+dateBR(b.day)+'</span><span class="cell-sub">'+esc(b.slot)+'</span></td><td><span class="cell-title">'+esc(b.supplier_name)+'</span></td><td><span class="cell-title">'+formatWeight(b.weight_kg)+' kg</span><span class="cell-sub">'+formatNum(b.box_count)+' caixas · '+formatNum(b.item_count)+' itens</span></td><td><span class="badge '+b.status+'">'+(b.status==='active'?'● Confirmado':'○ Cancelado')+'</span></td><td><div class="mini-actions"><button type="button" class="btn" data-ticket="'+b.id+'">Senha</button>'+(actions&&b.status==='active'?'<button type="button" class="btn btn-danger" data-cancel="'+b.id+'">Cancelar</button>':'')+'</div></td></tr>').join('')+'</tbody></table></div>';
}
async function renderDashboard(){
  $('#viewContent').innerHTML=pageHead('PAINEL DE CONTROLE','Dashboard','Indicadores das entregas no período selecionado.','<button class="btn" type="button" data-history-open>Pesquisar histórico</button><button class="btn btn-primary" type="button" data-view="schedule">＋ Novo agendamento</button>')+
  '<div class="card filter-card"><div class="field"><label for="dashFrom">De</label><input id="dashFrom" type="date" value="'+state.dashFrom+'"></div><div class="field"><label for="dashTo">Até</label><input id="dashTo" type="date" value="'+state.dashTo+'"></div>'+(state.user.role==='admin'?'<div class="field grow"><label for="dashSupplier">Fornecedor</label><select id="dashSupplier">'+supplierOptions(state.dashSupplier,true)+'</select></div>':'')+'<button class="btn" id="applyDash" type="button">Aplicar filtro</button></div><div id="dashBody"><div class="empty-state">Carregando indicadores...</div></div>';
  try{
    const params=new URLSearchParams({from:state.dashFrom,to:state.dashTo});
    if(state.dashSupplier)params.set('supplier_id',state.dashSupplier);
    const bookings=(await api('/api/bookings?'+params)).bookings;
    const active=bookings.filter(b=>b.status==='active');
    const sum=key=>active.reduce((a,b)=>a+Number(b[key]||0),0);
    const cards=[['▣','Carros agendados',formatNum(active.length),'veículos'],['◈','Peso total',formatWeight(sum('weight_kg')),'kg'],['≡','Quantidade de itens',formatNum(sum('item_count')),'itens'],['▤','Quantidade de caixas',formatNum(sum('box_count')),'caixas']];
    const weekdays=[['Segunda',1],['Terça',2],['Quarta',3],['Quinta',4],['Sexta',5],['Sábado',6]];
    const weekdayCounts=weekdays.map(([name,index])=>({name,count:active.filter(b=>new Date(b.day+'T12:00:00Z').getUTCDay()===index).length}));
    const maxDay=Math.max(1,...weekdayCounts.map(x=>x.count));
    const weekdayChart=weekdayCounts.map(x=>'<div class="chart-row"><span>'+x.name+'</span><div class="chart-track"><i style="width:'+(x.count/maxDay*100)+'%"></i></div><strong>'+formatNum(x.count)+'</strong></div>').join('');
    const colors=['#2b7fff','#71a8ff','#96bbff','#c9daf9'];
    const cargo=state.meta.cargoTypes.map((name,index)=>({name,index,count:active.filter(b=>b.cargo_type===name).length}));
    let degrees=0;
    const slices=cargo.map(x=>{const start=degrees;degrees+=active.length?x.count/active.length*360:0;return colors[x.index]+' '+start+'deg '+degrees+'deg'}).join(', ');
    const donutStyle=active.length?'background:conic-gradient('+slices+')':'background:#e7eef8';
    const legend=cargo.map(x=>'<div class="chart-legend-item"><i style="background:'+colors[x.index]+'"></i><span>'+esc(x.name)+'</span><strong>'+formatNum(x.count)+'</strong></div>').join('');
    $('#dashBody').innerHTML='<div class="stat-grid">'+cards.map(c=>'<div class="card stat-card"><div class="stat-icon">'+c[0]+'</div><p class="stat-label">'+c[1]+'</p><p class="stat-value">'+c[2]+'<span class="stat-unit">'+c[3]+'</span></p></div>').join('')+'</div>'+
      '<div class="charts-grid"><div class="card section-card"><div class="section-head"><div><h3>Entregas por dia da semana</h3><p>Quantidade de veículos confirmados no período</p></div></div><div class="weekday-chart">'+weekdayChart+'</div></div>'+
      '<div class="card section-card"><div class="section-head"><div><h3>Tipos de carga</h3><p>Distribuição dos agendamentos confirmados</p></div></div><div class="cargo-chart"><div class="donut-chart" style="'+donutStyle+'"><div><strong>'+formatNum(active.length)+'</strong><small>entregas</small></div></div><div class="chart-legend">'+legend+'</div></div></div></div>'+
      '<div class="dashboard-history card"><div><strong>Precisa consultar uma entrega?</strong><span>Pesquise o histórico com data, situação e fornecedor.</span></div><button class="btn" type="button" data-history-open>Abrir histórico →</button></div>';
  }catch(e){$('#dashBody').innerHTML='<div class="empty-state">'+esc(e.message)+'</div>';toast(e.message,true)}
}
function supplierField(){
  if(state.user.role!=='admin')return '<div class="field"><label>Fornecedor</label><input value="'+esc(state.user.supplier_name)+'" disabled><small>Seu cadastro está vinculado a esta empresa.</small></div>';
  return supplierCombo('supplier');
}
function renderSchedule(){
  $('#viewContent').innerHTML=pageHead('AGENDAMENTO','Nova entrega','Preencha os dados para solicitar o agendamento da entrega.')+
  '<div class="schedule-grid"><div class="card form-card"><form id="bookingForm"><div class="form-section-title"><span>1</span> Fornecedor e data</div>'+supplierField()+
  '<div class="field"><label for="bookingDay">Data da entrega *</label><input id="bookingDay" name="day" type="date" min="'+today()+'" value="'+state.slotDay+'" required><small>Atendimento de segunda a sábado.</small></div>'+
  '<div class="form-divider"></div><div class="form-section-title"><span>2</span> Dados da carga</div>'+
  '<div class="field-row"><div class="field"><label for="orderNumber">Número do pedido</label><input id="orderNumber" name="order_number" maxlength="80" placeholder="Ex: 12345"></div><div class="field"><label for="invoiceNumber">Nota fiscal</label><input id="invoiceNumber" name="invoice_number" maxlength="80" placeholder="Ex: 98765"></div></div>'+
  '<div class="field-row"><div class="field"><label for="weight">Peso da carga (kg) *</label><input id="weight" name="weight_kg" type="number" min="0.01" step="0.01" placeholder="Ex: 1250" required></div><div class="field"><label for="items">Quantidade de itens *</label><input id="items" name="item_count" type="number" min="0" step="1" placeholder="Ex: 80" required></div></div>'+
  '<div class="field-row"><div class="field"><label for="boxes">Quantidade de caixas *</label><input id="boxes" name="box_count" type="number" min="0" step="1" placeholder="Ex: 200" required></div><div class="field"><label for="vehicle">Tipo de veículo *</label><select id="vehicle" name="vehicle_type" required>'+optionList(state.meta.vehicleTypes)+'</select></div></div>'+
  '<div class="field"><label for="cargo">Tipo de carga *</label><select id="cargo" name="cargo_type" required>'+optionList(state.meta.cargoTypes)+'</select></div>'+
  '<div class="form-footer"><p>Após confirmar, a senha estará disponível para impressão e apresentação na portaria.</p><button type="submit" class="btn btn-primary">Confirmar agendamento →</button></div></form></div></div>';
}
async function renderBookings(){
  $('#viewContent').innerHTML=pageHead('CONSULTA','Agendamentos','Consulte entregas confirmadas, cancelamentos e histórico.','<button class="btn btn-primary" data-view="schedule" type="button">＋ Novo agendamento</button>')+
  '<div class="card section-card"><div class="tabs"><button type="button" data-booktab="active">Confirmados</button><button type="button" data-booktab="cancelled">Cancelados</button><button type="button" data-booktab="history">Histórico</button></div>'+
  '<div id="bookFilters" class="filter-card inline-filters"><div class="field"><label for="bookFrom">De</label><input id="bookFrom" type="date" value="'+state.bookFrom+'"></div><div class="field"><label for="bookTo">Até</label><input id="bookTo" type="date" value="'+state.bookTo+'"></div>'+(state.user.role==='admin'?'<div class="field grow"><label for="bookSupplier">Fornecedor</label><select id="bookSupplier">'+supplierOptions(state.bookSupplier,true)+'</select></div>':'')+'<button class="btn" id="applyBookings" type="button">Pesquisar</button></div>'+
  '<div id="bookBody"><div class="empty-state">Carregando agendamentos...</div></div></div>';
  if(state.bookTab==='history')showBookTab();else await refreshBookings();
}
async function refreshBookings(){
  try{
    const params=new URLSearchParams({from:state.bookFrom,to:state.bookTo});
    if(state.bookSupplier)params.set('supplier_id',state.bookSupplier);
    state.bookings=(await api('/api/bookings?'+params)).bookings;
    showBookTab();
  }catch(e){$('#bookBody').innerHTML='<div class="empty-state">'+esc(e.message)+'</div>';toast(e.message,true)}
}
function showBookTab(){
  document.querySelectorAll('[data-booktab]').forEach(b=>b.classList.toggle('active',b.dataset.booktab===state.bookTab));
  const filters=$('#bookFilters');if(filters)filters.hidden=state.bookTab==='history';
  if(state.bookTab==='history'){
    $('#bookBody').innerHTML=state.historySearched?
      '<div class="section-head"><div><h3>Resultado da pesquisa</h3><p>'+state.historyBookings.length+' registro(s) encontrados</p></div><button type="button" class="btn" data-history-open>Alterar filtros</button></div>'+bookingTable(state.historyBookings,false):
      '<div class="empty-state"><span class="empty-icon">⌕</span><strong>Pesquise o histórico de entregas</strong><span>Escolha o período e os filtros para consultar os agendamentos.</span><div style="margin-top:18px"><button class="btn btn-primary" type="button" data-history-open>Abrir filtros</button></div></div>';
    return;
  }
  $('#bookBody').innerHTML=bookingTable(state.bookings.filter(b=>b.status===state.bookTab));
}
function openHistoryModal(){
  state.bookTab='history';
  if(state.view!=='bookings')navigate('bookings');else showBookTab();
  $('#historyModalContent').innerHTML='<form id="historyForm" class="history-form"><p>Defina os filtros para consultar os agendamentos.</p><div class="field-row"><div class="field"><label for="historyFrom">De</label><input id="historyFrom" name="from" type="date" value="'+state.historyFrom+'" required></div><div class="field"><label for="historyTo">Até</label><input id="historyTo" name="to" type="date" value="'+state.historyTo+'" required></div></div>'+
    (state.user.role==='admin'?'<div class="field"><label for="historySupplier">Fornecedor</label><select id="historySupplier" name="supplier_id">'+supplierOptions(state.historySupplier,true)+'</select></div>':'')+
    '<div class="field"><label for="historyStatus">Situação</label><select id="historyStatus" name="status"><option value=""'+(!state.historyStatus?' selected':'')+'>Todas</option><option value="active"'+(state.historyStatus==='active'?' selected':'')+'>Confirmados</option><option value="cancelled"'+(state.historyStatus==='cancelled'?' selected':'')+'>Cancelados</option></select></div><div class="history-form-actions"><button type="button" class="btn" id="cancelHistory">Cancelar</button><button type="submit" class="btn btn-primary">Pesquisar histórico</button></div></form>';
  $('#historyModal').classList.remove('hidden');
  $('#historyFrom').focus();
}
function closeHistoryModal(){$('#historyModal').classList.add('hidden')}
async function renderAdmin(){
  $('#viewContent').innerHTML=pageHead('GESTÃO','Administração','Aprove novos acessos e mantenha o cadastro de fornecedores atualizado.')+'<div class="admin-grid"><div class="card pending-card"><div class="section-head"><div><h3>Cadastros aguardando aprovação</h3><p>Confira o vínculo antes de liberar o acesso.</p></div></div><div id="pendingBody" class="empty-state">Carregando...</div></div><div class="card supplier-card"><div class="section-head"><div><h3>Novo fornecedor</h3><p>Apenas administradores podem adicionar empresas.</p></div></div><form id="supplierForm"><div class="field"><label for="newSupplier">Razão social</label><input id="newSupplier" name="name" minlength="3" maxlength="160" required placeholder="Nome completo do fornecedor"></div><button type="submit" class="btn btn-primary btn-full">Cadastrar fornecedor</button></form><div class="info-panel" style="margin-top:22px"><h3>Base cadastrada</h3><p><strong>'+state.meta.suppliers.length+' fornecedores</strong> disponíveis para seleção.</p></div></div></div>';
  await refreshPending();
}
async function refreshPending(){
  try{
    const rows=(await api('/api/admin/pending')).users;
    $('#pendingBody').className='';
    $('#pendingBody').innerHTML=rows.length?rows.map(u=>'<div class="pending-item"><div><strong>'+esc(u.name)+'</strong><small>'+esc(u.email)+' · '+esc(u.supplier_name)+'</small></div><button class="btn btn-primary" data-approve="'+esc(u.id)+'">Aprovar</button></div>').join(''):'<div class="empty-state"><span class="empty-icon">✓</span><strong>Nenhuma aprovação pendente</strong><span>Novos cadastros aparecerão aqui.</span></div>';
  }catch(e){$('#pendingBody').textContent=e.message;toast(e.message,true)}
}
function openTicket(b){
  $('#ticketContent').innerHTML='<div class="ticket"><div class="ticket-header"><small>SENHA PARA ENTREGA DE MERCADORIA</small><div class="ticket-number">'+String(b.id).padStart(3,'0')+'</div></div><p class="ticket-protocol">Apresente esta senha no check-in · Protocolo AGE-'+b.id+'</p>'+
  [['Data da entrega',dateBR(b.day)],['Horário agendado',b.slot],['Apresentação','05:00 às 05:00'],['Filial','ATACADAO DIA A DIA S.A. · 17.457.404/0023-17'],['Endereço','SETOR POLO DE D J KUBITSCHEK TR 5 CJ 1, S/N - SANTA MARIA - BRASILIA/DF - CEP 72549-710'],['Doca','FLV'],['Fornecedor',b.supplier_name],['Número do pedido',b.order_number||'—'],['Nota fiscal',b.invoice_number||'—'],['Peso da carga',formatWeight(b.weight_kg)+' kg'],['Quantidade de itens',formatNum(b.item_count)],['Quantidade de caixas',formatNum(b.box_count)],['Tipo de veículo',b.vehicle_type],['Tipo de carga',b.cargo_type],['Situação',b.status==='active'?'Confirmado':'Cancelado']].map(x=>'<div class="ticket-row"><span>'+esc(x[0])+'</span><strong>'+esc(x[1])+'</strong></div>').join('')+'<p class="ticket-footer">Apresente esta senha à portaria no dia da entrega.</p></div>';
  $('#printTicket').disabled=b.status!=='active';
  $('#printTicket').title=b.status==='active'?'Imprimir senha':'Agendamento cancelado';
  $('#ticketModal').classList.remove('hidden');
}
document.addEventListener('click',async e=>{
  const choice=e.target.closest('[data-combo-option]');
  if(choice){
    const combo=choice.closest('[data-supplier-combo]');
    combo.querySelector('input[name="supplier_id"]').value=choice.dataset.comboOption;
    combo.querySelector('[data-combo-label]').textContent=choice.textContent;
    closeSupplierCombos();
    combo.querySelector('[data-combo-trigger]').focus();
    return;
  }
  const trigger=e.target.closest('[data-combo-trigger]');
  if(trigger){
    const combo=trigger.closest('[data-supplier-combo]');
    if(combo.querySelector('[data-combo-panel]').hidden)openSupplierCombo(combo);else closeSupplierCombos();
    return;
  }
  if(!e.target.closest('[data-supplier-combo]'))closeSupplierCombos();
  const auth=e.target.closest('[data-auth]');if(auth)return showAuth(auth.dataset.auth);
  const view=e.target.closest('[data-view]');if(view)return navigate(view.dataset.view);
  const history=e.target.closest('[data-history-open]');if(history)return openHistoryModal();
  const tab=e.target.closest('[data-booktab]');
  if(tab){
    state.bookTab=tab.dataset.booktab;
    if(state.bookTab==='history')return openHistoryModal();
    return refreshBookings();
  }
  const ticket=e.target.closest('[data-ticket]');
  if(ticket){try{openTicket((await api('/api/bookings/'+ticket.dataset.ticket)).booking)}catch(err){toast(err.message,true)}return}
  const cancel=e.target.closest('[data-cancel]');
  if(cancel){if(!confirm('Cancelar este agendamento? A vaga será liberada.'))return;try{await api('/api/bookings/'+cancel.dataset.cancel+'/cancel','POST',{});toast('Agendamento cancelado.');await renderBookings()}catch(err){toast(err.message,true)}return}
  const approve=e.target.closest('[data-approve]');
  if(approve){try{await api('/api/admin/users/'+approve.dataset.approve+'/approve','POST',{});toast('Acesso aprovado.');await refreshPending()}catch(err){toast(err.message,true)}return}
  if(e.target.id==='applyDash'){
    state.dashFrom=$('#dashFrom').value;state.dashTo=$('#dashTo').value;state.dashSupplier=$('#dashSupplier')?.value||'';
    return renderDashboard();
  }
  if(e.target.id==='applyBookings'){
    state.bookFrom=$('#bookFrom').value;state.bookTo=$('#bookTo').value;state.bookSupplier=$('#bookSupplier')?.value||'';
    return refreshBookings();
  }
  if(e.target.id==='menuBtn'){$('#sidebar').classList.add('open');$('#mobileOverlay').classList.add('show')}
  if(e.target.id==='mobileOverlay'){$('#sidebar').classList.remove('open');$('#mobileOverlay').classList.remove('show')}
  if(e.target.id==='closeTicket'||e.target.id==='ticketModal')$('#ticketModal').classList.add('hidden');
  if(e.target.id==='closeHistory'||e.target.id==='cancelHistory'||e.target.id==='historyModal')closeHistoryModal();
  if(e.target.id==='printTicket')window.print();
  if(e.target.id==='logoutBtn'){await api('/api/logout','POST',{});state.user=null;showAuth('login')}
});
document.addEventListener('input',e=>{
  if(e.target.matches('[data-combo-search]'))renderComboResults(e.target.closest('[data-supplier-combo]'),e.target.value);
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeSupplierCombos();closeHistoryModal();return}
  if(e.key==='Enter'&&e.target.matches('[data-combo-search]')){
    const first=e.target.closest('[data-supplier-combo]').querySelector('[data-combo-option]');
    if(first){e.preventDefault();first.click()}
  }
  if(e.key==='ArrowDown'&&e.target.matches('[data-combo-search]')){
    const first=e.target.closest('[data-supplier-combo]').querySelector('[data-combo-option]');
    if(first){e.preventDefault();first.focus()}
  }
});
document.addEventListener('change',e=>{
  if(e.target.id==='bookingDay')state.slotDay=e.target.value;
});
document.addEventListener('submit',async e=>{
  const form=e.target;
  if(!['bootstrapForm','registerForm','loginForm','bookingForm','supplierForm','historyForm'].includes(form.id))return;
  e.preventDefault();
  submitButton(form,true);
  const values=Object.fromEntries(new FormData(form));
  try{
    if(form.id==='bootstrapForm'){
      const r=await api('/api/bootstrap','POST',values);
      state.user=r.user;state.meta.bootstrap=false;toast('Administrador criado.');showApp();
    }
    if(form.id==='registerForm'){
      if(!values.supplier_id)throw new Error('Selecione um fornecedor.');
      const r=await api('/api/register','POST',values);
      showRegistrationReceived(r.message);
    }
    if(form.id==='loginForm'){
      const r=await api('/api/login','POST',values);
      state.user=r.user;showApp();
    }
    if(form.id==='bookingForm'){
      if(state.user.role==='admin'&&!values.supplier_id)throw new Error('Selecione um fornecedor.');
      values.weight_kg=Number(values.weight_kg);
      values.item_count=Number(values.item_count);
      values.box_count=Number(values.box_count);
      const r=await api('/api/bookings','POST',values);
      toast('Agendamento confirmado para '+r.booking.slot+'.');
      openTicket(r.booking);
      renderSchedule();
    }
    if(form.id==='supplierForm'){
      const r=await api('/api/admin/suppliers','POST',values);
      state.meta.suppliers.push(r.supplier);
      state.meta.suppliers.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
      toast('Fornecedor cadastrado.');
      await renderAdmin();
    }
    if(form.id==='historyForm'){
      if(values.from>values.to)throw new Error('A data inicial deve ser anterior à data final.');
      state.historyFrom=values.from;state.historyTo=values.to;
      state.historySupplier=values.supplier_id||'';
      state.historyStatus=values.status||'';
      const params=new URLSearchParams({from:state.historyFrom,to:state.historyTo});
      if(state.historySupplier)params.set('supplier_id',state.historySupplier);
      const rows=(await api('/api/bookings?'+params)).bookings;
      state.historyBookings=state.historyStatus?rows.filter(b=>b.status===state.historyStatus):rows;
      state.historySearched=true;
      closeHistoryModal();
      showBookTab();
    }
  }catch(err){toast(err.message,true)}
  finally{if(form.isConnected)submitButton(form,false)}
});
(async()=>{try{state.meta=await api('/api/meta');state.user=(await api('/api/me')).user;if(state.user)showApp();else showAuth()}catch(e){$('#authContent').innerHTML='<div class="auth-inner"><h2>Não foi possível carregar o portal</h2><p class="subtext">'+esc(e.message)+'</p><button class="btn" onclick="location.reload()">Tentar novamente</button></div>'}})();
