const $ = s => document.querySelector(s);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalizeSupplierNames = (value, supplierRecord=false) => {
  if(Array.isArray(value)){value.forEach(item=>normalizeSupplierNames(item,supplierRecord));return value}
  if(!value||typeof value!=='object')return value;
  for(const [key,item] of Object.entries(value)){
    if(typeof item==='string'&&(key==='supplier_name'||key==='requested_supplier_name'||supplierRecord&&key==='name'))value[key]=item.toLocaleUpperCase('pt-BR');
    else if(item&&typeof item==='object')normalizeSupplierNames(item,key==='suppliers'||key==='supplier');
  }
  return value;
};
const api = async (url, method='GET', body) => {
  const options = {method, credentials:'same-origin', headers:{}};
  if (body !== undefined) { options.headers['content-type']='application/json'; options.body=JSON.stringify(body); }
  const response = await fetch(url,options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
  return normalizeSupplierNames(data);
};
const state = {meta:null,user:null,view:'dashboard',authMode:'login',bookTab:'active',supplierBookTab:'active',supplierBookings:[],dashFrom:'',dashTo:'',dashSupplier:'',dashRequest:0,dashboardTab:'general',dashboardSupplierRows:[],dashboardDay:'',dashboardDayPage:0,arrivalDay:'',arrivalTab:'pending',arrivals:[],unscheduledArrivals:[],unscheduledArrivalsError:null,arrivalRequest:0,delayFrom:'',delayTo:'',delaySuppliers:[],delayRequest:0,delayDetailRequest:0,bookFrom:'',bookTo:'',bookSupplier:'',bookingsRequest:0,slotDay:'',selectedSlot:'',availableSlots:[],slotBlocked:false,availabilityRequest:0,bookingNoticeAcknowledged:false,bookings:[],pending:[],adminUsers:[],manualSuppliers:[],userSearch:'',userRoleFilter:'',blockedDays:[],editingUser:null,historyFrom:'',historyTo:'',historySupplier:'',historyStatus:'',historySearched:false,historyBookings:[],historyRequest:0,pendingNotifications:[],notificationSeen:[],notificationUserId:null};
let notificationTimer;
let bookingNoticeReturnFocus=null;
const notificationStorageKey = id => 'flv-notifications-seen:'+id;
function renderNotifications(){
  const unread=state.pendingNotifications.filter(u=>!state.notificationSeen.includes(String(u.id)));
  const count=$('#notificationCount');
  count.textContent=unread.length>99?'99+':String(unread.length);
  count.classList.toggle('hidden',unread.length===0);
  $('#notificationBell').setAttribute('aria-label',unread.length?unread.length+' cadastros novos aguardando aprovação':'Nenhuma nova notificação');
  $('#notificationSummary').textContent=unread.length?unread.length+' novo(s)':'Nenhum novo';
  $('#notificationList').innerHTML=unread.length?unread.map(u=>'<button type="button" class="notification-item" data-notification-user="'+esc(u.id)+'"><strong>'+esc(u.name)+'</strong><small>'+esc(u.supplier_name||'Fornecedor não informado')+'</small><span>Ver solicitação</span></button>').join(''):'<p class="notification-empty">Nenhum novo cadastro. As solicitações pendentes continuam na aba Usuários.</p>';
}
function updateNotifications(rows){
  state.pendingNotifications=rows;
  const valid=new Set(rows.map(u=>String(u.id)));
  const seen=state.notificationSeen.filter(id=>valid.has(id));
  if(seen.length!==state.notificationSeen.length){state.notificationSeen=seen;saveNotificationSeen()}
  renderNotifications();
}
function saveNotificationSeen(){try{localStorage.setItem(notificationStorageKey(state.user.id),JSON.stringify(state.notificationSeen))}catch{}}
async function refreshNotifications(){
  if(state.user?.role!=='admin')return;
  try{const rows=(await api('/api/admin/pending')).users;if(state.user?.role==='admin')updateNotifications(rows)}catch{}
}
function closeNotifications(){
  $('#notificationPanel').classList.add('hidden');
  $('#notificationBell').setAttribute('aria-expanded','false');
  renderNotifications();
}
function setupNotifications(){
  clearInterval(notificationTimer);
  if(state.user?.role!=='admin'){state.pendingNotifications=[];state.notificationSeen=[];state.notificationUserId=null;closeNotifications();return}
  if(state.notificationUserId!==state.user.id){
    state.notificationUserId=state.user.id;
    try{const saved=JSON.parse(localStorage.getItem(notificationStorageKey(state.user.id))||'[]');state.notificationSeen=Array.isArray(saved)?saved.map(String):[]}catch{state.notificationSeen=[]}
  }
  closeNotifications();
  refreshNotifications();
  notificationTimer=setInterval(refreshNotifications,30000);
}
const dateBR = day => day ? day.split('-').reverse().join('/') : '—';
const shortDate = day => new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'2-digit',month:'long'}).format(new Date(day+'T12:00:00Z'));
const formatNum = n => new Intl.NumberFormat('pt-BR').format(n || 0);
const formatWeight = n => new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2}).format(n || 0);
const today = () => state.meta?.today || new Date().toISOString().slice(0,10);
const dateOffset = (day, n) => {const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const lastOfMonth = day => {const d=new Date(day+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+1,0);return d.toISOString().slice(0,10)};
const nextOpenDay = day => {let x=day;while(new Date(x+'T12:00:00Z').getUTCDay()===0)x=dateOffset(x,1);return x};
const isSunday = day => new Date(day+'T12:00:00Z').getUTCDay()===0;
const firstAvailableDeliveryDay = () => nextOpenDay(dateOffset(today(),1));
const toast = (message,error=false) => {const el=$('#toast');el.textContent=message;el.className='toast show'+(error?' error':'');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='toast',4500)};
const submitButton = (form, busy) => {const button=form.querySelector('button[type="submit"]');if(button){button.disabled=busy;button.dataset.text ||= button.textContent;button.textContent=busy?'Aguarde...':button.dataset.text}};
const supplierOptions = (selected='',includeAll=false) => (includeAll?'<option value="">Todos os fornecedores</option>':'<option value="">Selecione um fornecedor</option>')+state.meta.suppliers.map(s=>'<option value="'+s.id+'"'+(String(selected)===String(s.id)?' selected':'')+'>'+esc(s.name)+'</option>').join('');
const optionList = arr => '<option value="">Selecione</option>'+arr.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('');
const roleNames = {admin:'Administrador',supplier:'Fornecedor',commercial:'Comercial',cd:'CD'};
const allowedViews = role => role==='admin'?['dashboard','schedule','bookings','arrivals','users','admin']:role==='cd'?['dashboard','arrivals']:role==='commercial'?['dashboard']:['schedule','bookings'];
const defaultView = role => ['admin','commercial','cd'].includes(role)?'dashboard':'schedule';
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
const eyeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const lockIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
const mailIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>';
const googleIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.22-.2-1.75H12v3.77h5.5a4.73 4.73 0 0 1-2.05 3.1v2.52h3.32c1.94-1.79 2.83-4.43 2.83-7.64Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.44l-3.32-2.52c-.92.62-2.09.99-3.29.99-2.53 0-4.68-1.71-5.45-4.01H3.11v2.58A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.55 14.02A6.02 6.02 0 0 1 6.23 12c0-.7.12-1.39.32-2.02V7.4H3.11A10 10 0 0 0 2 12c0 1.61.39 3.13 1.11 4.6l3.44-2.58Z"/><path fill="#EA4335" d="M12 5.97c1.44 0 2.73.5 3.75 1.47l2.95-2.95A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.89 5.4l3.44 2.58C7.32 7.68 9.47 5.97 12 5.97Z"/></svg>';
function passwordField(id,name,autocomplete){
  return '<div class="field"><label for="'+id+'">Senha</label><div class="input-icon-wrap">'+lockIcon+'<input id="'+id+'" name="'+name+'" type="password" minlength="6" required autocomplete="'+autocomplete+'" placeholder="Digite sua senha"><button class="password-toggle" type="button" data-password-toggle="'+id+'" aria-label="Mostrar senha" aria-pressed="false">'+eyeIcon+'</button></div>'+(autocomplete==='new-password'?'<small>Mínimo de 6 caracteres.</small>':'')+'</div>';
}
function showAuth(mode='login'){
  clearInterval(notificationTimer);
  state.authMode=mode;
  $('#appShell').classList.add('hidden');$('#authScreen').classList.remove('hidden');
  let form='';
  if(state.meta.bootstrap){
    form='<p class="eyebrow">CONFIGURAÇÃO INICIAL</p><h2>Crie o acesso administrador</h2><p class="subtext">Este primeiro acesso controla aprovações e o cadastro de fornecedores no teste local.</p><form id="bootstrapForm"><div class="field"><label for="bootName">Seu nome</label><input id="bootName" name="name" required autocomplete="name"></div><div class="field"><label for="bootEmail">Email</label><input id="bootEmail" name="email" type="email" required autocomplete="email"></div>'+passwordField('bootPassword','password','new-password')+'<button class="btn btn-primary btn-full" type="submit">Criar administrador</button></form>';
  } else {
    form='<p class="eyebrow">BEM-VINDO AO PORTAL</p><h2>'+(mode==='login'?'Acesse sua conta':'Crie sua conta')+'</h2><p class="subtext">'+(mode==='login'?'Entre para acompanhar seus agendamentos e emitir a senha de entrega.':'Escolha sua empresa ou digite o nome dela. O acesso será liberado após aprovação.')+'</p><div class="auth-tabs"><button type="button" data-auth="login" class="'+(mode==='login'?'active':'')+'">Entrar</button><button type="button" data-auth="register" class="'+(mode==='register'?'active':'')+'">Cadastrar</button></div>';
    if(mode==='login'){
      form+='<form id="loginForm"><div class="field"><label for="loginEmail">Email</label><div class="input-icon-wrap">'+mailIcon+'<input id="loginEmail" name="email" type="email" placeholder="seu@email.com" required autocomplete="email"></div></div>'+passwordField('loginPassword','password','current-password')+'<button class="btn btn-primary btn-full auth-submit" type="submit">Entrar no portal <span aria-hidden="true">→</span></button></form>'+
        (state.meta.googleEnabled?'<div class="social-divider"><span>ou</span></div><button class="btn btn-full google-button" type="button" data-google-login>'+googleIcon+' Entrar com Google</button><p class="social-note">Use o mesmo email de uma conta já aprovada.</p>':'')+
        '<p class="auth-note">Seu acesso mostra apenas os dados do seu fornecedor.</p>';
    } else {
      form+='<form id="registerForm"><div class="field"><label for="regName">Seu nome</label><input id="regName" name="name" required autocomplete="name"></div><div class="field"><label for="regEmail">Email de acesso</label><input id="regEmail" name="email" type="email" required autocomplete="email"></div><div id="regSupplierSelect">'+supplierCombo('regSupplier')+'</div><button type="button" class="text-link supplier-mode-toggle" id="toggleNewSupplier">Não encontrou sua empresa? Digitar nome</button><div id="regSupplierTyped" class="field hidden"><label for="regSupplierName">Nome do fornecedor *</label><input id="regSupplierName" name="supplier_name" minlength="3" maxlength="160" placeholder="Digite a razão social" autocomplete="organization"><small>O administrador conferirá esta empresa antes de liberar o acesso.</small></div>'+passwordField('regPassword','password','new-password')+'<button class="btn btn-primary btn-full auth-submit" type="submit">Solicitar cadastro <span aria-hidden="true">→</span></button></form><p class="auth-note">A equipe avaliará o cadastro e liberará o acesso após aprovação.</p>';
    }
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
  setupNotifications();
  const views=allowedViews(state.user.role);
  document.querySelectorAll('.nav-link[data-view]').forEach(el=>{
    el.classList.toggle('hidden',!views.includes(el.dataset.view));
  });
  state.dashFrom=today();state.dashTo=lastOfMonth(today());state.dashSupplier='';
  state.arrivalDay=today();state.arrivalTab='pending';state.delayFrom=today().slice(0,8)+'01';state.delayTo=today();
  if(!state.bookFrom){const firstBookingDay=firstAvailableDeliveryDay();state.bookFrom=firstBookingDay;state.bookTo=firstBookingDay;state.historyFrom=dateOffset(today(),-365);state.historyTo=today();state.slotDay=firstBookingDay}
  if(!views.includes(state.view))state.view=defaultView(state.user.role);
  navigate(state.view);
}
function navigate(view){
  closeDashboardZoom();
  closeNotifications();
  if(!allowedViews(state.user.role).includes(view))view=defaultView(state.user.role);
  state.view=view;
  if(view==='schedule'&&state.user.role==='supplier')state.bookingNoticeAcknowledged=false;
  const titles={dashboard:'Dashboard',schedule:'Novo agendamento',bookings:'Agendamentos',arrivals:'Chegada CD',users:'Usuários',admin:'Administração'};
  $('#pageTitle').textContent=titles[view];$('#crumb').textContent=titles[view].toUpperCase();
  document.querySelectorAll('.nav-link[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('#sidebar').classList.remove('open');$('#mobileOverlay').classList.remove('show');
  if(view==='dashboard')renderDashboard();
  if(view==='schedule')renderSchedule();
  if(view==='bookings')renderBookings();
  if(view==='arrivals')renderArrivals();
  if(view==='users')renderUsers();
  if(view==='admin')renderAdmin();
}
const pageHead=(kicker,title,description,action='')=>'<div class="page-head"><div><p class="eyebrow">'+kicker+'</p><h1>'+title+'</h1><p>'+description+'</p></div><div class="page-actions">'+action+'</div></div>';
const bookingStatusLabel=status=>status==='active'?'● Confirmado':status==='no_show'?'⚠ No show':'○ Cancelado';
function bookingTable(rows,actions=true,adminCheck=false){
  if(!rows.length)return '<div class="empty-state"><span class="empty-icon">▤</span><strong>Nenhum agendamento encontrado</strong><span>Altere o período ou crie um novo agendamento.</span></div>';
  return '<div class="table-wrap"><table class="data-table"><thead><tr><th>Senha</th><th>Data e horário</th><th>Fornecedor</th><th>Carga</th><th>Situação</th><th></th></tr></thead><tbody>'+rows.map(b=>'<tr><td><span class="cell-title">#'+String(b.id).padStart(3,'0')+'</span><span class="cell-sub">'+esc(b.vehicle_type)+'</span></td><td><span class="cell-title">'+dateBR(b.day)+'</span><span class="cell-sub">'+esc(b.slot)+'</span></td><td><span class="cell-title">'+esc(b.supplier_name)+'</span></td><td><span class="cell-title">'+formatWeight(b.weight_kg)+' kg</span><span class="cell-sub">'+formatNum(b.box_count)+' caixas · '+formatNum(b.item_count)+' itens</span></td><td><span class="badge '+b.status+'">'+bookingStatusLabel(b.status)+'</span></td><td><div class="mini-actions"><button type="button" class="btn" data-ticket="'+b.id+'">Senha</button>'+(adminCheck&&b.status==='active'&&b.day<=today()?'<button type="button" class="btn btn-no-show" data-no-show="'+b.id+'" title="Marcar como No show">Check</button>':'')+(actions&&b.status==='active'?'<button type="button" class="btn btn-danger" data-cancel="'+b.id+'">Cancelar</button>':'')+'</div></td></tr>').join('')+'</tbody></table></div>';
}
const weekdayName=day=>new Intl.DateTimeFormat('pt-BR',{weekday:'long'}).format(new Date(day+'T12:00:00Z')).replace(/^./,letter=>letter.toUpperCase());
let expandedDashboardCard=null;
function closeDashboardZoom(){
  if(!expandedDashboardCard)return;
  const card=expandedDashboardCard;
  card.classList.remove('dashboard-zoomed');card.removeAttribute('role');card.removeAttribute('aria-modal');
  card.querySelector('[data-card-zoom]')?.setAttribute('aria-label','Ampliar painel');
  document.querySelector('.dashboard-zoom-backdrop')?.remove();
  document.body.classList.remove('dashboard-has-zoom');
  expandedDashboardCard=null;
}
function toggleDashboardZoom(button){
  const card=button.closest('[data-zoom-panel]');
  if(!card)return;
  if(expandedDashboardCard===card){closeDashboardZoom();button.focus();return}
  closeDashboardZoom();
  const backdrop=document.createElement('div');backdrop.className='dashboard-zoom-backdrop';
  backdrop.addEventListener('click',closeDashboardZoom);
  document.body.append(backdrop);
  expandedDashboardCard=card;
  card.classList.add('dashboard-zoomed');card.setAttribute('role','dialog');card.setAttribute('aria-modal','true');
  button.setAttribute('aria-label','Fechar painel ampliado');
  document.body.classList.add('dashboard-has-zoom');button.focus();
}
function enableDashboardZoom(){
  const selector=state.dashboardTab==='arrivals'?'.cd-analytics-grid .cd-section':'.stat-grid .stat-card, .charts-grid .section-card';
  $('#dashBody').querySelectorAll(selector).forEach(card=>{
    card.dataset.zoomPanel='';
    const body=document.createElement('div');body.className='dashboard-zoom-body';
    while(card.firstChild)body.append(card.firstChild);
    const button=document.createElement('button');button.type='button';button.className='dashboard-zoom-button';button.dataset.cardZoom='';
    button.setAttribute('aria-label','Ampliar painel');button.title='Ampliar painel';
    button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5m13-5v5h-5"/></svg>';
    card.append(body,button);
  });
}
async function renderDashboard(){
  closeDashboardZoom();
  const requestId=++state.dashRequest;
  const admin=state.user.role==='admin',commercial=['commercial','cd'].includes(state.user.role);
  const tabs='<div class="dashboard-view-tabs" role="group" aria-label="Subabas do Dashboard"><button type="button" data-dashboard-tab="general" class="'+(state.dashboardTab==='general'?'active':'')+'" aria-pressed="'+(state.dashboardTab==='general')+'">Visão geral</button><button type="button" data-dashboard-tab="arrivals" class="'+(state.dashboardTab==='arrivals'?'active':'')+'" aria-pressed="'+(state.dashboardTab==='arrivals')+'">Chegadas CD</button></div>';
  const actions=tabs+(admin?'<button class="btn" type="button" data-history-open>Pesquisar histórico</button><button class="btn btn-primary" type="button" data-view="schedule">+ Novo agendamento</button>':'');
  $('#viewContent').innerHTML=pageHead('PAINEL DE CONTROLE','Dashboard',state.dashboardTab==='arrivals'?'Acompanhe chegadas, pontualidade e atrasos dos fornecedores.':'Indicadores das entregas no período selecionado.',actions)+'<div class="card filter-card"><div class="field"><label for="dashFrom">De</label><input id="dashFrom" type="date" value="'+state.dashFrom+'"></div><div class="field"><label for="dashTo">Até</label><input id="dashTo" type="date" value="'+state.dashTo+'"></div>'+(admin?'<div class="field grow"><label for="dashSupplier">Fornecedor</label><select id="dashSupplier">'+supplierOptions(state.dashSupplier,true)+'</select></div>':'')+'<small id="dashFilterFeedback" class="filter-feedback" aria-live="polite">Os resultados são atualizados automaticamente.</small></div><div id="dashBody"><div class="empty-state">Carregando indicadores...</div></div>';
  if(state.dashboardTab==='arrivals')return renderArrivalPerformance(requestId);
  try{
    const params=new URLSearchParams({from:state.dashFrom,to:state.dashTo});
    if(state.dashSupplier)params.set('supplier_id',state.dashSupplier);
    let active=[],summary=null,dailySupplierRows=[];
    if(commercial){
      summary=await api('/api/dashboard?'+params);
    }else{
      active=(await api('/api/bookings?'+params)).bookings.filter(booking=>booking.status==='active');
    }
    dailySupplierRows=await api('/api/dashboard/daily-suppliers?'+params);
    if(requestId!==state.dashRequest)return;
    state.dashboardSupplierRows=dailySupplierRows;
    const sum=key=>active.reduce((a,b)=>a+Number(b[key]||0),0);
    const totalBookings=commercial?Number(summary.carros||0):active.length;
    const totalWeight=commercial?Number(summary.peso||0):sum('weight_kg');
    const totalItems=commercial?Number(summary.items||0):sum('item_count');
    const totalBoxes=commercial?Number(summary.boxes||0):sum('box_count');
    const cards=[['▣','Carros agendados',formatNum(totalBookings),'veículos'],['◈','Peso total',formatWeight(totalWeight),'kg'],['≡','Quantidade de itens',formatNum(totalItems),'itens'],['▤','Quantidade de caixas',formatNum(totalBoxes),'caixas']];
    const dayGroups=new Map();
    for(const row of dailySupplierRows){let day=dayGroups.get(row.day);if(!day){day={day:row.day,count:0};dayGroups.set(row.day,day)}day.count+=Number(row.appointment_count||0)}
    const dailyCounts=Array.from(dayGroups.values()).sort((a,b)=>a.day.localeCompare(b.day));
    const maxDay=Math.max(1,...dailyCounts.map(row=>row.count));
    const dailyChart=dailyCounts.length?dailyCounts.map(row=>'<div class="chart-row"><div class="chart-day-label"><span>'+weekdayName(row.day)+'</span><small>'+dateBR(row.day)+'</small></div><div class="chart-track"><i style="width:'+(row.count/maxDay*100)+'%"></i></div><strong>'+formatNum(row.count)+'</strong><button type="button" class="day-detail-button" data-dashboard-day="'+esc(row.day)+'" aria-label="Ver fornecedores agendados em '+dateBR(row.day)+'">+</button></div>').join(''):'<div class="empty-state">Nenhum fornecedor agendado no período.</div>';
    const colors=['#2b7fff','#71a8ff','#96bbff','#c9daf9'];
    const cargo=state.meta.cargoTypes.map((name,index)=>({name,index,count:commercial?Number(summary.cargo_counts.find(x=>x.name===name)?.count||0):active.filter(b=>b.cargo_type===name).length}));
    let degrees=0;
    const slices=cargo.map(x=>{const start=degrees;degrees+=totalBookings?x.count/totalBookings*360:0;return colors[x.index]+' '+start+'deg '+degrees+'deg'}).join(', ');
    const donutStyle=totalBookings?'background:conic-gradient('+slices+')':'background:#e7eef8';
    const legend=cargo.map(x=>'<div class="chart-legend-item"><i style="background:'+colors[x.index]+'"></i><span>'+esc(x.name)+'</span><strong>'+formatNum(x.count)+'</strong></div>').join('');
    $('#dashBody').innerHTML='<div class="stat-grid">'+cards.map(c=>'<div class="card stat-card"><div class="stat-icon">'+c[0]+'</div><p class="stat-label">'+c[1]+'</p><p class="stat-value">'+c[2]+'<span class="stat-unit">'+c[3]+'</span></p></div>').join('')+'</div>'+'<div class="charts-grid"><div class="card section-card"><div class="section-head"><div><h3>Fornecedores por data</h3><p>Fornecedores com agendamentos confirmados no período</p></div></div><div class="weekday-chart daily-supplier-chart admin-details">'+dailyChart+'</div></div>'+'<div class="card section-card"><div class="section-head"><div><h3>Tipos de carga</h3><p>Distribuição dos agendamentos confirmados</p></div></div><div class="cargo-chart"><div class="donut-chart" style="'+donutStyle+'"><div><strong>'+formatNum(totalBookings)+'</strong><small>entregas</small></div></div><div class="chart-legend">'+legend+'</div></div></div></div>'+'<div class="dashboard-history card"><div><strong>Atrasos na chegada</strong><span>Consulte fornecedores com atrasos e veja cada ocorrência por data.</span></div><button class="btn" type="button" data-delay-open>Ver atrasos →</button></div>'+(admin?'<div class="dashboard-history card"><div><strong>Precisa consultar uma entrega?</strong><span>Pesquise o histórico com data, situação e fornecedor.</span></div><button class="btn" type="button" data-history-open>Abrir histórico →</button></div>':'');
    enableDashboardZoom();
  }catch(error){if(requestId!==state.dashRequest)return;$('#dashBody').innerHTML='<div class="empty-state">'+esc(error.message)+'</div>';toast(error.message,true)}
}
const negativeDelay=minutes=>'-'+durationLabel(minutes);
async function renderArrivalPerformance(requestId){
  try{
    const params=new URLSearchParams({from:state.dashFrom,to:state.dashTo});
    if(state.dashSupplier)params.set('supplier_id',state.dashSupplier);
    const [result,unscheduledSummary]=await Promise.all([
      api('/api/dashboard/arrival-performance?'+params),
      api('/api/dashboard/unscheduled-arrivals?'+params)
    ]);
    if(requestId!==state.dashRequest||state.view!=='dashboard'||state.dashboardTab!=='arrivals')return;
    const totals=result.totals||{};
    const scheduled=Number(totals.scheduled||0),recorded=Number(totals.recorded||0),late=Number(totals.late||0);
    const noShow=Number(totals.no_show||0),scheduledToDate=Number(totals.scheduled_to_date||0);
    const noShowPercent=scheduledToDate?formatWeight(noShow/scheduledToDate*100)+'%':'—';
    const early=Number(totals.early||0),onTime=Number(totals.on_time||0),pending=Number(totals.pending||0),upcoming=Number(totals.upcoming||0);
    const punctuality=recorded?Math.round((early+onTime)/recorded*100)+'%':'—';
    const metrics=[
      ['Agendamentos',formatNum(scheduled),'carros',''],
      ['Chegadas registradas',formatNum(recorded),'carros',''],
      ['No horário ou antes',formatNum(early+onTime),'chegadas','good'],
      ['Chegadas atrasadas',formatNum(late),'chegadas','late'],
      ['No show',formatNum(noShow),'ausências','no-show']
    ];
    const cards=metrics.map(([label,value,unit,tone])=>'<div class="card cd-metric '+tone+'"><span>'+label+'</span><strong>'+value+'</strong><small>'+unit+'</small></div>').join('');
    const top=(result.top_suppliers||[]).sort((a,b)=>Number(b.late_minutes)-Number(a.late_minutes)||Number(b.late)-Number(a.late)||a.supplier_name.localeCompare(b.supplier_name,'pt-BR'));
    state.delaySuppliers=top;
    state.delayFrom=state.dashFrom;state.delayTo=state.dashTo;
    const topTable=top.length?'<div class="table-wrap"><table class="data-table cd-performance-table"><thead><tr><th>Fornecedor</th><th>Dias com atraso</th><th>Chegadas atrasadas</th><th>Tempo perdido</th><th>Média por atraso</th></tr></thead><tbody>'+top.map((row,index)=>'<tr><td><button class="delay-supplier-link" type="button" data-performance-supplier="'+index+'">'+esc(row.supplier_name)+'</button></td><td>'+formatNum(row.late_days)+'</td><td>'+formatNum(row.late)+'</td><td><strong class="negative-time">'+negativeDelay(row.late_minutes)+'</strong></td><td><strong class="negative-time">'+negativeDelay(row.average_late_minutes)+'</strong></td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state"><strong>Nenhum atraso registrado no período.</strong><span>Os fornecedores aparecerão aqui quando houver chegadas após o horário agendado.</span></div>';
    const noShowRows=result.top_no_show||[];
    const noShowTable=noShowRows.length?'<div class="table-wrap"><table class="data-table cd-performance-table"><thead><tr><th>Fornecedor</th><th>No show</th><th>Agendados até hoje</th><th>Percentual</th></tr></thead><tbody>'+noShowRows.map(row=>'<tr><td><strong>'+esc(row.supplier_name)+'</strong></td><td><strong class="no-show-value">'+formatNum(row.no_show)+'</strong></td><td>'+formatNum(row.scheduled_to_date)+'</td><td><strong class="no-show-value">'+formatWeight(row.no_show_percent)+'%</strong></td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state"><strong>Nenhum No show no período.</strong><span>As ausências registradas na Chegada CD aparecerão aqui.</span></div>';
    const days=result.days||[];
    const dailyMax=Math.max(1,...days.map(row=>Number(row.scheduled||0)));
    const daily=days.length?'<div class="cd-daily-list">'+days.map(row=>'<div class="cd-daily-row"><span>'+dateBR(row.day)+'</span><div class="cd-daily-track"><i style="width:'+(Number(row.recorded||0)/dailyMax*100)+'%"></i></div><span>'+formatNum(row.recorded)+' / '+formatNum(row.scheduled)+' chegadas</span><div class="cd-day-results"><strong class="'+(Number(row.late)>0?'negative-time':'')+'">'+(Number(row.late)>0?formatNum(row.late)+' atraso(s) · '+negativeDelay(row.late_minutes):'Sem atraso')+'</strong><small class="no-show-value">'+formatNum(row.no_show)+' No show</small></div></div>').join('')+'</div>':'<div class="empty-state">Nenhum agendamento no período selecionado.</div>';
    const slots=result.slots||[];
    const slotTable=slots.length?'<div class="table-wrap cd-slot-wrap"><table class="data-table cd-performance-table cd-slot-table"><thead><tr><th>Horário</th><th>Agendados</th><th>Chegadas</th><th>Atrasos</th><th>No show</th><th>Tempo perdido</th></tr></thead><tbody>'+slots.map(row=>'<tr><td><strong>'+esc(String(row.slot).slice(0,5))+'</strong></td><td>'+formatNum(row.scheduled)+'</td><td>'+formatNum(row.recorded)+'</td><td>'+formatNum(row.late)+'</td><td class="no-show-value">'+formatNum(row.no_show)+'</td><td class="'+(Number(row.late)>0?'negative-time':'')+'">'+(Number(row.late)>0?negativeDelay(row.late_minutes):'-')+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state">Nenhum horário agendado neste período.</div>';
    const walkins=unscheduledSummary.top_suppliers||[];
    const walkinTable=walkins.length?'<div class="table-wrap"><table class="data-table unscheduled-summary-table"><thead><tr><th>Fornecedor</th><th>Sem agenda</th><th>Agendados</th><th>% sem agenda</th></tr></thead><tbody>'+walkins.map(row=>'<tr><td><strong>'+esc(row.supplier_name)+'</strong></td><td>'+formatNum(row.unscheduled)+'</td><td>'+formatNum(row.scheduled)+'</td><td>'+formatWeight(row.percent)+'%</td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state"><strong>Nenhum veículo fora da agenda no período.</strong></div>';
    const scheduledCars=Number(unscheduledSummary.scheduled||0),walkinCars=Number(unscheduledSummary.unscheduled||0),totalCars=scheduledCars+walkinCars;
    const scheduledPercent=totalCars?Math.round(scheduledCars/totalCars*1000)/10:0;
    const walkinPercent=totalCars?Math.round(walkinCars/totalCars*1000)/10:0;
    const walkinPanel='<div class="card section-card cd-unscheduled-panel"><div class="section-head"><div><h3>Veículos fora da agenda</h3><p>Comparativo e fornecedores com mais chegadas sem agendamento, considerando datas até hoje.</p></div></div><div class="cd-unscheduled-metrics"><div><span>Total de veículos</span><strong>'+formatNum(totalCars)+'</strong></div><div><span>Carros agendados</span><strong>'+formatNum(scheduledCars)+'</strong></div><div><span>Carros fora da agenda</span><strong>'+formatNum(walkinCars)+'</strong></div><div><span>Percentual de carros agendados</span><strong>'+formatWeight(scheduledPercent)+'%</strong></div><div><span>Percentual de carros fora da agenda</span><strong>'+formatWeight(walkinPercent)+'%</strong></div></div><h4>Fornecedores com mais veículos fora da agenda</h4>'+walkinTable+'<small>Os veículos sem agendamento não entram na medição de atrasos.</small></div>';
    $('#dashBody').innerHTML='<div class="cd-metrics">'+cards+'</div>'+
      '<div class="cd-status-strip card"><div><strong>'+punctuality+'</strong><span>Pontualidade: '+formatNum(onTime)+' no horário · '+formatNum(early)+' adiantadas</span></div><div><strong class="no-show-value">'+noShowPercent+'</strong><span>No show entre agendamentos até hoje</span></div><div><strong>'+formatNum(pending)+'</strong><span>Aguardando registro até hoje</span></div><div><strong>'+formatNum(upcoming)+'</strong><span>Agendamentos futuros</span></div><div><strong class="negative-time">'+(late?negativeDelay(totals.average_late_minutes):'—')+'</strong><span>Atraso médio por chegada atrasada</span></div></div>'+
      '<div class="cd-analytics-grid"><div class="card section-card cd-section"><div class="section-head"><div><h3>Fornecedores com mais atrasos</h3><p>Clique no nome para ver cada data.</p></div></div>'+topTable+'</div><div class="card section-card cd-section"><div class="section-head"><div><h3>Fornecedores com mais No show</h3><p>Ausências registradas e percentual sobre agendamentos até hoje.</p></div></div>'+noShowTable+'</div></div>'+
      '<div class="cd-analytics-grid"><div class="card section-card cd-section"><div class="section-head"><div><h3>Chegadas por data</h3><p>Registradas em relação aos agendamentos do período.</p></div></div>'+daily+'</div><div class="card section-card cd-section"><div class="section-head"><div><h3>Atrasos e No show por horário</h3><p>Compare os horários com mais ocorrências.</p></div></div>'+slotTable+'</div></div>'+walkinPanel+'<p class="cd-panel-note">No show é calculado sobre os agendamentos até hoje no período; agendamentos futuros ficam fora do percentual. Tempo negativo em vermelho indica chegada após o horário agendado.</p>';
    enableDashboardZoom();
  }catch(error){if(requestId!==state.dashRequest)return;$('#dashBody').innerHTML='<div class="empty-state">'+esc(error.message)+'</div>';toast(error.message,true)}
}
const dashboardDayPageSize=12;
const dashboardDayRows=day=>state.dashboardSupplierRows.filter(row=>row.day===day).sort((a,b)=>String(a.slots||'').slice(0,5).localeCompare(String(b.slots||'').slice(0,5))||a.supplier_name.localeCompare(b.supplier_name,'pt-BR'));
function renderDashboardDayPage(){
  const day=state.dashboardDay;
  const rows=dashboardDayRows(day);
  const pages=Math.max(1,Math.ceil(rows.length/dashboardDayPageSize));
  state.dashboardDayPage=Math.max(0,Math.min(state.dashboardDayPage,pages-1));
  const current=rows.slice(state.dashboardDayPage*dashboardDayPageSize,(state.dashboardDayPage+1)*dashboardDayPageSize);
  $('#dashboardDayModalTitle').textContent='Fornecedores agendados — '+weekdayName(day)+' '+dateBR(day);
  $('#dashboardDayModalContent').innerHTML=rows.length?'<div class="table-wrap"><table class="data-table supplier-day-table"><thead><tr><th>Fornecedor</th><th>Agendamentos</th><th>Horários</th><th>Peso total</th><th>Caixas</th><th>Itens</th></tr></thead><tbody>'+current.map(row=>'<tr><td><span class="cell-title">'+esc(row.supplier_name)+'</span></td><td>'+formatNum(row.appointment_count)+'</td><td>'+esc(row.slots)+'</td><td>'+formatWeight(row.weight_total)+' kg</td><td>'+formatNum(row.box_total)+'</td><td>'+formatNum(row.item_total)+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state">Nenhum agendamento encontrado para esta data.</div>';
  $('#dashboardDayPagination').innerHTML='<span>'+formatNum(rows.length)+' agendamento(s) · Página '+(state.dashboardDayPage+1)+' de '+pages+'</span><div class="dashboard-page-actions"><button type="button" class="btn" data-dashboard-page="'+(state.dashboardDayPage-1)+'"'+(state.dashboardDayPage===0?' disabled':'')+'>Anterior</button><button type="button" class="btn" data-dashboard-page="'+(state.dashboardDayPage+1)+'"'+(state.dashboardDayPage===pages-1?' disabled':'')+'>Próxima</button></div>';
}
function openDashboardDayModal(day){
  state.dashboardDay=day;
  state.dashboardDayPage=0;
  renderDashboardDayPage();
  $('#dashboardDayModal').classList.remove('hidden');
  $('#closeDashboardDay').focus();
}
function closeDashboardDayModal(){$('#dashboardDayModal').classList.add('hidden')}
function printDashboardDay(){
  if($('#dashboardDayModal').classList.contains('hidden')||!state.dashboardDay)return;
  const day=state.dashboardDay,rows=dashboardDayRows(day);
  if(!rows.length){toast('Não há agendamentos para imprimir nesta data.',true);return}
  const totals=rows.reduce((sum,row)=>({cars:sum.cars+Number(row.appointment_count||0),weight:sum.weight+Number(row.weight_total||0),boxes:sum.boxes+Number(row.box_total||0),items:sum.items+Number(row.item_total||0)}),{cars:0,weight:0,boxes:0,items:0});
  $('#agendaPrint').innerHTML='<header class="agenda-print-header"><div><h1>Agenda de recebimento FLV</h1><p>'+esc(weekdayName(day))+' · '+dateBR(day)+'</p></div><div class="agenda-print-totals"><div><span>Total de carros</span><strong>'+formatNum(totals.cars)+'</strong></div><div><span>Peso total</span><strong>'+formatWeight(totals.weight)+' kg</strong></div><div><span>Total de caixas</span><strong>'+formatNum(totals.boxes)+'</strong></div><div><span>Total de itens</span><strong>'+formatNum(totals.items)+'</strong></div></div></header><table class="agenda-print-table"><thead><tr><th>Fornecedor</th><th>Horário agendado</th><th>Peso</th><th>Caixas</th><th>Itens</th><th>Horário chegada</th></tr></thead><tbody>'+rows.map(row=>'<tr><td>'+esc(row.supplier_name)+'</td><td>'+esc(row.slots)+'</td><td>'+formatWeight(row.weight_total)+' kg</td><td>'+formatNum(row.box_total)+'</td><td>'+formatNum(row.item_total)+'</td><td class="arrival-cell"></td></tr>').join('')+'</tbody></table>';
  document.body.classList.add('printing-agenda');
  window.print();
}
window.addEventListener('afterprint',()=>{document.body.classList.remove('printing-agenda');$('#agendaPrint').replaceChildren()});
const minutesOfTime=value=>Number(String(value).slice(0,2))*60+Number(String(value).slice(3,5));
const currentLocalDay=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const currentLocalTime=()=>new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
const durationLabel=value=>{const minutes=Math.round(Number(value)||0);return minutes>=60?Math.floor(minutes/60)+'h '+String(minutes%60).padStart(2,'0')+'min':minutes+' min'};
async function renderArrivals(){
  $('#viewContent').innerHTML=pageHead('RECEBIMENTO','Chegada CD','Registre a chegada dos veículos na portaria, com ou sem agendamento.')+
    '<div class="card section-card arrival-card"><div class="arrival-heading"><div class="field"><label for="arrivalDay">Data da entrega</label><input id="arrivalDay" type="date" value="'+esc(state.arrivalDay)+'"></div><p>Selecione a data para consultar as chegadas. O horário pode ser registrado no dia da entrega ou depois.</p></div><div class="tabs arrival-tabs"><button type="button" data-arrival-tab="pending">Aguardando chegada <span id="arrivalPendingCount"></span></button><button type="button" data-arrival-tab="recorded">Chegada registrada <span id="arrivalRecordedCount"></span></button><button type="button" data-arrival-tab="no_show">No show <span id="arrivalNoShowCount"></span></button><button type="button" data-arrival-tab="unscheduled">Fora da agenda <span id="arrivalUnscheduledCount"></span></button></div><div class="arrival-extra-actions"><button type="button" class="btn" data-unscheduled-open>+ Adicionar veículo fora da agenda</button></div><div id="arrivalBody" class="empty-state">Carregando agendamentos...</div></div>';
  await refreshArrivals();
}
async function refreshArrivals(){
  const request=++state.arrivalRequest,day=state.arrivalDay;
  const target=$('#arrivalBody');if(target)target.innerHTML='<div class="empty-state">Carregando agendamentos...</div>';
  try{
    const [result,unscheduled]=await Promise.allSettled([
      api('/api/arrivals?'+new URLSearchParams({day})),
      api('/api/arrivals/unscheduled?'+new URLSearchParams({day}))
    ]);
    if(request!==state.arrivalRequest||state.view!=='arrivals')return;
    if(result.status==='rejected')throw result.reason;
    state.arrivals=result.value.bookings;
    state.unscheduledArrivals=unscheduled.status==='fulfilled'?unscheduled.value.arrivals:[];
    state.unscheduledArrivalsError=unscheduled.status==='rejected'?unscheduled.reason.message:null;
    renderArrivalTab();
  }catch(error){if(request!==state.arrivalRequest)return;$('#arrivalBody').innerHTML='<div class="empty-state">'+esc(error.message)+'</div>'}
}
function renderArrivalTab(){
  const pending=state.arrivals.filter(row=>row.status==='active'&&!row.arrival_time);
  const recorded=state.arrivals.filter(row=>row.status==='active'&&row.arrival_time);
  const noShow=state.arrivals.filter(row=>row.status==='no_show');
  $('#arrivalPendingCount').textContent='('+formatNum(pending.length)+')';
  $('#arrivalRecordedCount').textContent='('+formatNum(recorded.length)+')';
  $('#arrivalNoShowCount').textContent='('+formatNum(noShow.length)+')';
  $('#arrivalUnscheduledCount').textContent='('+formatNum(state.unscheduledArrivals.length)+')';
  document.querySelectorAll('[data-arrival-tab]').forEach(button=>button.classList.toggle('active',button.dataset.arrivalTab===state.arrivalTab));
  if(state.arrivalTab==='unscheduled'){
    if(state.unscheduledArrivalsError){$('#arrivalBody').innerHTML='<div class="empty-state">'+esc(state.unscheduledArrivalsError)+'</div>';return}
    const rows=state.unscheduledArrivals;
    $('#arrivalBody').innerHTML=rows.length?'<div class="table-wrap"><table class="data-table unscheduled-list-table"><thead><tr><th>Fornecedor</th><th>Data da chegada</th><th>Horário de chegada</th><th>Situação</th></tr></thead><tbody>'+rows.map(row=>'<tr><td><strong>'+esc(row.supplier_name)+'</strong></td><td>'+dateBR(row.day)+'</td><td>'+esc(String(row.arrival_time).slice(0,5))+'</td><td><span class="badge no_show">Fora da agenda</span></td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state"><strong>Nenhum veículo fora da agenda nesta data.</strong></div>';
    return;
  }
  const rows=state.arrivalTab==='pending'?pending:state.arrivalTab==='recorded'?recorded:noShow;
  const future=state.arrivalDay>today(),localTime=currentLocalTime();
  const emptyMessage={pending:'Nenhuma chegada pendente nesta data.',recorded:'Nenhuma chegada registrada nesta data.',no_show:'Nenhum No show nesta data.'};
  $('#arrivalBody').innerHTML=rows.length?'<div class="table-wrap"><table class="data-table arrival-table"><thead><tr><th>Senha / horário</th><th>Fornecedor</th><th>Pedido / nota fiscal</th><th>Carga agendada</th><th>Veículo / tipo</th><th>Chegada / situação</th></tr></thead><tbody>'+
    rows.map(row=>{
      const id=Number(row.booking_id||row.id),slot=String(row.slot).slice(0,5);
      const delay=row.arrival_time?minutesOfTime(row.arrival_time)-minutesOfTime(row.slot):null;
      const canNoShow=!future&&(state.arrivalDay<today()||slot<=localTime);
      const arrivalControl=row.status==='no_show'?'<span class="badge no_show">No show</span>':
        '<div class="arrival-actions"><form class="arrival-form" data-arrival-form="'+id+'"><label class="sr-only" for="arrivalTime-'+id+'">Horário de chegada de '+esc(row.supplier_name)+'</label><input id="arrivalTime-'+id+'" type="time" name="arrival_time" value="'+esc(row.arrival_time?String(row.arrival_time).slice(0,5):'')+'" required'+(future?' disabled':'')+'><button class="btn btn-primary" type="submit"'+(future||!row.arrival_time?' disabled title="Informe o horário de chegada"':'')+'>'+(row.arrival_time?'Atualizar':'Registrar')+'</button></form>'+
        (row.arrival_time?'':'<button class="btn btn-no-show" type="button" data-arrival-no-show="'+id+'"'+(canNoShow?'':' disabled title="Disponível após o horário agendado"')+'>No show</button>')+'</div>'+
        (delay===null?'':'<small class="arrival-indicator '+(delay>0?'late':'on-time')+'">'+(delay>0?'Atraso de '+durationLabel(delay):'No horário')+'</small>');
      return '<tr><td><span class="cell-title">#'+String(id).padStart(3,'0')+'</span><span class="cell-sub">'+esc(slot)+'</span></td><td><span class="cell-title">'+esc(row.supplier_name)+'</span></td><td>'+esc(row.order_number||'—')+'<span class="cell-sub">NF: '+esc(row.invoice_number||'—')+'</span></td><td><span class="cell-title">'+formatWeight(row.weight_kg)+' kg</span><span class="cell-sub">'+formatNum(row.box_count)+' caixas · '+formatNum(row.item_count)+' itens</span></td><td>'+esc(row.vehicle_type)+'<span class="cell-sub">'+esc(row.cargo_type)+'</span></td><td>'+arrivalControl+'</td></tr>';
    }).join('')+'</tbody></table></div>':'<div class="empty-state"><strong>'+emptyMessage[state.arrivalTab]+'</strong></div>';
}
async function openUnscheduledArrivalModal(){
  if(!['admin','cd'].includes(state.user?.role))return;
  state.meta.suppliers=(await api('/api/meta')).suppliers;
  const day=currentLocalDay();
  $('#unscheduledArrivalContent').innerHTML='<form id="unscheduledArrivalForm" class="unscheduled-arrival-form"><p class="subtext">Registre um veículo por vez. Como não há horário agendado, este lançamento não entra no cálculo de atrasos.</p>'+supplierCombo('unscheduledSupplier')+'<div class="field"><label for="unscheduledDay">Data da chegada *</label><input id="unscheduledDay" type="date" name="day" value="'+day+'" max="'+day+'" required></div><div class="field"><label for="unscheduledTime">Horário de chegada *</label><input id="unscheduledTime" type="time" name="arrival_time" required></div><div class="history-form-actions"><button type="button" class="btn" id="cancelUnscheduledArrival">Cancelar</button><button type="submit" class="btn btn-primary">Registrar veículo</button></div></form>';
  $('#unscheduledArrivalModal').classList.remove('hidden');
  $('#unscheduledSupplierTrigger').focus();
}
function closeUnscheduledArrivalModal(){
  $('#unscheduledArrivalModal').classList.add('hidden');
  closeSupplierCombos();
}
function updateArrivalSubmit(input){
  const button=input.closest('form[data-arrival-form]')?.querySelector('button[type="submit"]');
  if(!button)return;
  button.disabled=input.disabled||!input.value||!input.validity.valid;
  button.title=button.disabled?'Informe o horário de chegada':'';
}
function closeDelayModal(){state.delayRequest++;state.delayDetailRequest++;$('#delayDetailModal').classList.add('hidden');$('#delayModal').classList.add('hidden')}
async function openDelayModal(){
  $('#delayModal').classList.remove('hidden');
  await refreshDelaySummary();
}
async function refreshDelaySummary(){
  const request=++state.delayRequest;
  const target=$('#delayModalContent');
  target.innerHTML='<div class="delay-filters"><div class="field"><label for="delayFrom">De</label><input id="delayFrom" type="date" value="'+esc(state.delayFrom)+'"></div><div class="field"><label for="delayTo">Até</label><input id="delayTo" type="date" value="'+esc(state.delayTo)+'"></div></div><p class="delay-explainer">Dias com atraso contam datas distintas. O tempo total soma os minutos de cada chegada após o horário agendado.</p><div id="delaySummaryBody" class="empty-state">Carregando atrasos...</div>';
  if(state.delayFrom>state.delayTo){$('#delaySummaryBody').textContent='A data inicial deve ser anterior à data final.';return}
  try{
    const result=await api('/api/dashboard/delays?'+new URLSearchParams({from:state.delayFrom,to:state.delayTo}));
    if(request!==state.delayRequest||$('#delayModal').classList.contains('hidden'))return;
    state.delaySuppliers=result.suppliers;
    $('#delaySummaryBody').innerHTML=result.suppliers.length?'<div class="table-wrap"><table class="data-table delay-table"><thead><tr><th>Fornecedor</th><th>Dias com atraso</th><th>Chegadas atrasadas</th><th>Tempo total</th><th>Média por chegada</th></tr></thead><tbody>'+result.suppliers.map((row,index)=>'<tr><td><button class="delay-supplier-link" type="button" data-delay-index="'+index+'">'+esc(row.supplier_name)+'</button></td><td>'+formatNum(row.late_days)+'</td><td>'+formatNum(row.late_arrivals)+'</td><td>'+durationLabel(row.total_delay_minutes)+'</td><td>'+durationLabel(row.average_delay_minutes)+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state"><strong>Nenhuma chegada com atraso no período.</strong><span>Altere as datas para consultar outro intervalo.</span></div>';
  }catch(error){if(request===state.delayRequest)$('#delaySummaryBody').innerHTML='<div class="empty-state">'+esc(error.message)+'</div>'}
}
async function openDelayDetail(index){
  const supplier=state.delaySuppliers[index];if(!supplier)return;
  const request=++state.delayDetailRequest;
  $('#delayDetailTitle').textContent='Atrasos — '+supplier.supplier_name;
  $('#delayDetailModal').classList.remove('hidden');
  $('#delayDetailContent').innerHTML='<div class="empty-state">Carregando ocorrências...</div>';
  try{
    const result=await api('/api/dashboard/delays/'+supplier.supplier_id+'?'+new URLSearchParams({from:state.delayFrom,to:state.delayTo}));
    if(request!==state.delayDetailRequest||$('#delayDetailModal').classList.contains('hidden'))return;
    $('#delayDetailContent').innerHTML='<p class="delay-explainer">De '+dateBR(state.delayFrom)+' até '+dateBR(state.delayTo)+' · '+formatNum(result.arrivals.length)+' chegada(s) atrasada(s)</p><div class="table-wrap"><table class="data-table delay-table"><thead><tr><th>Data</th><th>Horário agendado</th><th>Horário chegada</th><th>Tempo de atraso</th></tr></thead><tbody>'+result.arrivals.map(row=>'<tr><td>'+dateBR(row.day)+'</td><td>'+esc(String(row.slot).slice(0,5))+'</td><td>'+esc(String(row.arrival_time).slice(0,5))+'</td><td><strong>'+durationLabel(row.delay_minutes)+'</strong></td></tr>').join('')+'</tbody></table></div>';
  }catch(error){if(request===state.delayDetailRequest)$('#delayDetailContent').innerHTML='<div class="empty-state">'+esc(error.message)+'</div>'}
}
function supplierField(){
  if(state.user.role!=='admin'){
    const linked=state.user.supplier_id&&state.user.supplier_name;
    return '<div class="field"><label for="linkedSupplier">Fornecedor vinculado</label><input id="linkedSupplier" value="'+esc(linked?state.user.supplier_name:'Fornecedor não vinculado')+'" readonly aria-readonly="true"><small>'+(linked?'Este agendamento será registrado somente para o fornecedor vinculado ao seu cadastro.':'Seu usuário está sem fornecedor vinculado. Peça ao administrador para corrigir o cadastro antes de agendar.')+'</small></div>';
  }
  return supplierCombo('supplier');
}
function renderSchedule(){
  const minimumDay=firstAvailableDeliveryDay();
  if(!state.slotDay||state.slotDay<minimumDay||isSunday(state.slotDay))state.slotDay=minimumDay;
  $('#viewContent').innerHTML=pageHead('AGENDAMENTO','Nova entrega','Preencha os dados para solicitar o agendamento da entrega.')+
  '<div class="schedule-grid"><div class="card form-card"><form id="bookingForm"><div class="form-section-title"><span>1</span> Fornecedor e data</div>'+supplierField()+
  '<div class="field"><label for="bookingDay">Data da entrega *</label><input id="bookingDay" name="day" type="date" min="'+minimumDay+'" value="'+state.slotDay+'" required><small>Agendamentos somente a partir do próximo dia disponível. Domingos não recebem agendamentos.</small></div>'+
  '<div class="field booking-time-field"><label>Horário de agendamento *</label><small>Selecione um horário disponível. Horários sem vagas não aparecem.</small><div id="bookingSlots" class="booking-slot-grid" aria-label="Horários disponíveis"><div class="slot-message">Carregando horários disponíveis...</div></div><input id="bookingSlot" name="slot" type="hidden" value="'+esc(state.selectedSlot)+'"></div>'+
  '<div class="form-divider"></div><div class="form-section-title"><span>2</span> Dados da carga</div>'+
  '<div class="field-row"><div class="field"><label for="orderNumber">Número do pedido</label><input id="orderNumber" name="order_number" maxlength="80" placeholder="Ex: 12345"></div><div class="field"><label for="invoiceNumber">Nota fiscal</label><input id="invoiceNumber" name="invoice_number" maxlength="80" placeholder="Ex: 98765"></div></div>'+
  '<div class="field-row"><div class="field"><label for="weight">Peso da carga (kg) *</label><input id="weight" name="weight_kg" type="number" min="0.01" step="0.01" placeholder="Ex: 1250" required></div><div class="field"><label for="items">Quantidade de itens *</label><input id="items" name="item_count" type="number" min="0" step="1" placeholder="Ex: 80" required></div></div>'+
  '<div class="field-row"><div class="field"><label for="boxes">Quantidade de caixas</label><input id="boxes" name="box_count" type="number" min="0" step="1" placeholder="Ex: 200"><small>Opcional. Se não houver caixas, deixe em branco.</small></div><div class="field"><label for="vehicle">Tipo de veículo *</label><select id="vehicle" name="vehicle_type" required>'+optionList(state.meta.vehicleTypes)+'</select></div></div>'+
  '<div class="field"><label for="cargo">Tipo de carga *</label><select id="cargo" name="cargo_type" required>'+optionList(state.meta.cargoTypes)+'</select></div>'+
  '<div class="form-footer"><p>Após confirmar, a senha estará disponível para impressão e apresentação na portaria.</p><button type="submit" class="btn btn-primary">Confirmar agendamento →</button></div></form></div></div>'+
  '';
  refreshAvailableSlots(state.slotDay);
}
function openBookingNotice(target){
  if(state.bookingNoticeAcknowledged||state.user?.role!=='supplier')return;
  bookingNoticeReturnFocus=target||null;
  $('#appShell').inert=true;
  $('#bookingNoticeModal').classList.remove('hidden');
  $('#confirmBookingNotice').focus();
}
function closeBookingNotice(){
  if($('#bookingNoticeModal').classList.contains('hidden'))return;
  state.bookingNoticeAcknowledged=true;
  $('#bookingNoticeModal').classList.add('hidden');
  $('#appShell').inert=false;
  if(bookingNoticeReturnFocus?.isConnected&&state.view==='schedule')bookingNoticeReturnFocus.focus();
  bookingNoticeReturnFocus=null;
}
function renderAvailableSlots(){
  const target=$('#bookingSlots');if(!target)return;
  if(state.slotBlocked){target.innerHTML='<div class="slot-message blocked">Agendamentos bloqueados para '+dateBR(state.slotDay)+'. Escolha outra data.</div>';state.selectedSlot=''}
  else if(!state.availableSlots.length){target.innerHTML='<div class="slot-message">Não há horários disponíveis para esta data. Escolha outra data para continuar.</div>';state.selectedSlot=''}
  else target.innerHTML=state.availableSlots.map(slot=>'<button type="button" class="booking-slot'+(state.selectedSlot===slot?' selected':'')+'" aria-pressed="'+(state.selectedSlot===slot)+'" data-booking-slot="'+esc(slot)+'">'+esc(slot)+'</button>').join('');
  const input=$('#bookingSlot');if(input)input.value=state.selectedSlot;
}
async function refreshAvailableSlots(day){
  const requestId=++state.availabilityRequest;
  const target=$('#bookingSlots');if(!target)return;
  state.availableSlots=[];
  state.slotBlocked=false;
  target.innerHTML='<div class="slot-message">Carregando horários disponíveis...</div>';
  try{
    const result=await api('/api/availability?day='+encodeURIComponent(day));
    if(requestId!==state.availabilityRequest||state.view!=='schedule'||state.slotDay!==day)return;
    state.availableSlots=result.slots||[];
    state.slotBlocked=Boolean(result.blocked);
    if(!state.availableSlots.includes(state.selectedSlot))state.selectedSlot='';
    if(!state.availableSlots.length&&!state.slotBlocked)openBookingCapacityModal();
    renderAvailableSlots();
  }catch(error){
    if(requestId!==state.availabilityRequest||state.view!=='schedule'||state.slotDay!==day)return;
    target.innerHTML='<div class="slot-message error">'+esc(error.message)+'</div>';
  }
}
async function refreshSupplierBookings(){
  try{
    state.supplierBookings=(await api('/api/bookings')).bookings;
    showSupplierBookings();
  }catch(e){$('#supplierBookBody').textContent=e.message;toast(e.message,true)}
}
function showSupplierBookings(){
  document.querySelectorAll('[data-supplier-booktab]').forEach(b=>b.classList.toggle('active',b.dataset.supplierBooktab===state.supplierBookTab));
  $('#supplierBookBody').innerHTML=bookingTable(state.supplierBookings.filter(b=>b.status===state.supplierBookTab));
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
  $('#bookBody').innerHTML=bookingTable(state.bookings.filter(b=>b.status===state.bookTab),true,state.user.role==='admin');
}
function openHistoryModal(){
  state.bookTab='history';
  if(state.view!=='bookings')navigate('bookings');else showBookTab();
  $('#historyModalContent').innerHTML='<form id="historyForm" class="history-form"><p>Defina os filtros para consultar os agendamentos.</p><div class="field-row"><div class="field"><label for="historyFrom">De</label><input id="historyFrom" name="from" type="date" value="'+state.historyFrom+'" required></div><div class="field"><label for="historyTo">Até</label><input id="historyTo" name="to" type="date" value="'+state.historyTo+'" required></div></div>'+
    (state.user.role==='admin'?'<div class="field"><label for="historySupplier">Fornecedor</label><select id="historySupplier" name="supplier_id">'+supplierOptions(state.historySupplier,true)+'</select></div>':'')+
    '<div class="field"><label for="historyStatus">Situação</label><select id="historyStatus" name="status"><option value=""'+(!state.historyStatus?' selected':'')+'>Todas</option><option value="active"'+(state.historyStatus==='active'?' selected':'')+'>Confirmados</option><option value="cancelled"'+(state.historyStatus==='cancelled'?' selected':'')+'>Cancelados</option><option value="no_show"'+(state.historyStatus==='no_show'?' selected':'')+'>No show</option></select></div><div class="history-form-actions"><button type="button" class="btn" id="cancelHistory">Cancelar</button><button type="submit" class="btn btn-primary">Pesquisar histórico</button></div></form>';
  $('#historyModal').classList.remove('hidden');
  $('#historyFrom').focus();
}
function closeHistoryModal(){$('#historyModal').classList.add('hidden')}
async function renderUsers(){
  $('#viewContent').innerHTML=pageHead('GESTÃO DE ACESSOS','Usuários','Avalie solicitações e gerencie os acessos do portal.')+
  '<div class="card section-card"><div class="section-head"><div><h3>Aguardando aprovação</h3><p>Escolha se cada conta terá acesso de Administrador, Fornecedor, Comercial ou CD.</p></div></div><div id="pendingBody" class="empty-state">Carregando...</div></div>'+
  '<div class="card section-card users-card"><div class="section-head"><div><h3>Usuários do portal</h3><p>Altere o perfil de contas ativas. A exclusão de fornecedores mantém o histórico das entregas.</p></div></div>'+
  '<div class="user-filters"><label class="user-search"><span class="sr-only">Pesquisar por nome, fornecedor ou perfil</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></svg><input id="userSearch" type="search" autocomplete="off" placeholder="Pesquisar nome, fornecedor ou perfil" value="'+esc(state.userSearch)+'"></label><label class="user-role-filter"><span>Perfil</span><select id="userRoleFilter"><option value="">Todos os perfis</option><option value="admin"'+(state.userRoleFilter==='admin'?' selected':'')+'>Administrador</option><option value="supplier"'+(state.userRoleFilter==='supplier'?' selected':'')+'>Fornecedor</option><option value="commercial"'+(state.userRoleFilter==='commercial'?' selected':'')+'>Comercial</option><option value="cd"'+(state.userRoleFilter==='cd'?' selected':'')+'>CD</option></select></label><span id="userSearchCount" class="user-search-count" aria-live="polite"></span></div>'+
  '<div id="adminUsersBody" class="empty-state">Carregando...</div></div>';
  await Promise.all([refreshPending(),refreshAdminUsers()]);
}
async function refreshPending(){
  try{
    const rows=(await api('/api/admin/pending')).users;
    updateNotifications(rows);
    const target=$('#pendingBody');if(!target)return;
    target.className='';
    target.innerHTML=rows.length?rows.map(u=>'<div class="pending-item"><div><strong>'+esc(u.name)+'</strong><small>'+esc(u.email)+' · '+esc(u.supplier_name||'Vínculo administrativo')+'</small>'+(u.requested_supplier_name?'<small class="requested-tag">Fornecedor digitado no cadastro</small>':'')+'</div><div class="approval-actions"><label class="sr-only" for="approveRole-'+esc(u.id)+'">Tipo de acesso</label><select id="approveRole-'+esc(u.id)+'" data-approve-role><option value="supplier">Fornecedor</option><option value="admin">Administrador</option><option value="commercial">Comercial</option><option value="cd">CD</option></select><button class="btn btn-primary" data-approve="'+esc(u.id)+'">Aprovar</button></div></div>').join(''):'<div class="empty-state"><span class="empty-icon">✓</span><strong>Nenhuma aprovação pendente</strong><span>Novos cadastros aparecerão aqui.</span></div>';
  }catch(e){const target=$('#pendingBody');if(target)target.textContent=e.message;toast(e.message,true)}
}
async function refreshAdminUsers(){
  try{
    const rows=(await api('/api/admin/users')).users;
    state.adminUsers=rows;
    renderAdminUserRows();
  }catch(e){const target=$('#adminUsersBody');if(target)target.textContent=e.message;toast(e.message,true)}
}
const normalizeUserSearch=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
function renderAdminUserRows(){
  const target=$('#adminUsersBody');if(!target)return;
  const terms=normalizeUserSearch(state.userSearch).trim().split(/\s+/).filter(Boolean);
  const rows=state.adminUsers.filter(u=>{
    if(state.userRoleFilter&&u.role!==state.userRoleFilter)return false;
    const text=normalizeUserSearch([u.name,u.supplier_name,u.email,roleNames[u.role],u.role].join(' '));
    return terms.every(term=>text.includes(term));
  });
  $('#userSearchCount').textContent=formatNum(rows.length)+' de '+formatNum(state.adminUsers.length)+' usuários';
  target.className='';
  target.innerHTML=rows.length?rows.map(u=>'<div class="pending-item user-item"><div><strong>'+esc(u.name)+'</strong><small>'+esc(u.email)+' · '+esc(u.supplier_name||'Sem fornecedor vinculado')+'</small></div><div class="user-actions"><span class="badge '+(u.role==='admin'?'role-admin':u.role==='commercial'?'role-commercial':u.role==='cd'?'role-cd':'role-supplier')+'">'+esc(roleNames[u.role]||u.role)+'</span><span class="badge '+(u.status==='active'?'active':'cancelled')+'">'+(u.status==='active'?'Ativo':'Pendente')+'</span>'+(u.status==='active'&&u.id!==state.user.id?'<button class="btn" type="button" data-edit-user="'+esc(u.id)+'">Alterar perfil</button>':'')+(u.role==='supplier'?'<button class="btn btn-danger" type="button" data-delete-user="'+esc(u.id)+'">Excluir</button>':'')+'</div></div>').join(''):'<div class="empty-state"><strong>'+(state.adminUsers.length?'Nenhum usuário encontrado para este filtro.':'Nenhum usuário cadastrado')+'</strong></div>';
}
function openUserRoleModal(id){
  const user=state.adminUsers.find(row=>String(row.id)===String(id));
  if(!user)return;
  state.editingUser=user;
  $('#userRoleModalContent').innerHTML='<form id="userRoleForm"><p class="subtext">Escolha o perfil e, para Fornecedor, vincule a empresa que essa conta poderá acessar.</p><div class="field"><label for="userRole">Perfil</label><select id="userRole" name="role"><option value="admin"'+(user.role==='admin'?' selected':'')+'>Administrador</option><option value="supplier"'+(user.role==='supplier'?' selected':'')+'>Fornecedor</option><option value="commercial"'+(user.role==='commercial'?' selected':'')+'>Comercial</option><option value="cd"'+(user.role==='cd'?' selected':'')+'>CD</option></select></div><div id="userRoleSupplierField" class="field"><label for="userRoleSupplierMode">Fornecedor</label><select id="userRoleSupplierMode"><option value="existing">Selecionar fornecedor cadastrado</option><option value="new">Cadastrar novo fornecedor</option></select><div id="userRoleExistingSupplier" class="field"><label for="userRoleSupplier">Fornecedor vinculado</label><select id="userRoleSupplier" name="supplier_id">'+supplierOptions(user.supplier_id)+'</select></div><div id="userRoleNewSupplier" class="field" hidden><label for="userRoleSupplierName">Nova razão social</label><input id="userRoleSupplierName" name="supplier_name" minlength="3" maxlength="160" placeholder="Nome completo do fornecedor"></div></div><div class="history-form-actions"><button type="button" class="btn" id="cancelUserRole">Cancelar</button><button type="submit" class="btn btn-primary">Salvar perfil</button></div></form>';
  $('#userRoleModal').classList.remove('hidden');
  updateUserRoleSupplierVisibility();
}
function closeUserRoleModal(){$('#userRoleModal').classList.add('hidden');state.editingUser=null}
function updateUserRoleSupplierVisibility(){
  const field=$('#userRoleSupplierField');
  const role=$('#userRole')?.value;
  if(field){
    const active=role==='supplier',isNew=$('#userRoleSupplierMode').value==='new';
    field.hidden=!active;
    $('#userRoleExistingSupplier').hidden=!active||isNew;
    $('#userRoleNewSupplier').hidden=!active||!isNew;
    $('#userRoleSupplier').required=active&&!isNew;
    $('#userRoleSupplierName').required=active&&isNew;
  }
}
function updateDailyLimitPreview(){
  const start=$('#scheduleStart'),end=$('#scheduleEnd'),intervalField=$('#scheduleInterval'),capacityField=$('#scheduleCapacity'),limit=$('#scheduleDailyLimit');
  if(!start||!end||!intervalField||!capacityField||!limit)return;
  const interval=Number(intervalField.value),capacity=Number(capacityField.value);
  const minute=value=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3)):NaN;
  const startMinute=minute(start.value),endMinute=minute(end.value),duration=endMinute-startMinute;
  const valid=[30,60].includes(interval)&&Number.isInteger(capacity)&&capacity>0&&duration>0&&duration%interval===0&&startMinute%30===0&&endMinute%30===0&&(interval!==60||(startMinute%60===0&&endMinute%60===0));
  limit.value=valid?String((Math.floor(duration/interval)+1)*capacity):'';
  const step=interval*60;
  start.step=String(step);end.step=String(step);
}
function renderAdmin(){
  const rules=state.meta.scheduling;
  $('#viewContent').innerHTML=pageHead('ADMINISTRAÇÃO','Configurações','Cadastre fornecedores e configure as regras que valem para todos os agendamentos.')+
  '<div class="card section-card"><div class="section-head"><div><h3>Sistemática global de agendamento</h3><p>As regras salvas serão aplicadas a todos os fornecedores.</p></div></div><form id="schedulingForm" class="settings-form"><div class="field-row"><div class="field"><label for="scheduleStart">Início da janela</label><input id="scheduleStart" name="start_time" type="time" step="1800" value="'+esc(rules.start_time)+'" required></div><div class="field"><label for="scheduleEnd">Final da janela</label><input id="scheduleEnd" name="end_time" type="time" step="1800" value="'+esc(rules.end_time)+'" required><small>O horário final é o início da última faixa disponível.</small></div></div><div class="field-row"><div class="field"><label for="scheduleInterval">Intervalo entre faixas</label><select id="scheduleInterval" name="interval_minutes"><option value="30"'+(Number(rules.interval_minutes)===30?' selected':'')+'>A cada meia hora</option><option value="60"'+(Number(rules.interval_minutes)===60?' selected':'')+'>A cada hora</option></select></div><div class="field"><label for="scheduleCapacity">Carros por faixa</label><input id="scheduleCapacity" name="vehicles_per_slot" type="number" min="1" max="10000" step="1" value="'+esc(rules.vehicles_per_slot)+'" required></div></div><div class="field"><label for="scheduleDailyLimit">Limite de veículos por dia</label><input id="scheduleDailyLimit" name="daily_vehicle_limit" type="number" min="1" max="1000000" step="1" value="'+esc(rules.daily_vehicle_limit)+'" readonly required><small>Calculado automaticamente: faixas disponíveis × carros por faixa.</small></div><button type="submit" class="btn btn-primary">Salvar sistemática</button></form></div>'+
  '<div class="card section-card blocked-days-card"><div class="section-head"><div><h3>Dias sem agendamento</h3><p>Bloqueie datas de feriado, manutenção ou parada da operação. Domingos já são bloqueados automaticamente.</p></div></div><form id="blockedDayForm" class="blocked-day-form"><div class="field"><label for="blockedDay">Data a bloquear</label><input id="blockedDay" name="day" type="date" min="'+dateOffset(today(),1)+'" required></div><button type="submit" class="btn btn-primary">Bloquear dia</button></form><div id="blockedDaysList" class="blocked-days-list" aria-live="polite">Carregando datas...</div><small class="blocked-days-note">O bloqueio impede novos agendamentos. Agendamentos já confirmados para a data continuam registrados.</small></div>'+
  '<div class="card supplier-card admin-supplier-card"><div class="section-head"><div><h3>Novo fornecedor</h3><p>Somente administradores podem cadastrar empresas diretamente.</p></div></div><form id="supplierForm"><div class="field"><label for="newSupplier">Razão social</label><input id="newSupplier" name="name" minlength="3" maxlength="160" required placeholder="Nome completo do fornecedor"></div><button type="submit" class="btn btn-primary">Cadastrar fornecedor</button></form><div class="info-panel" style="margin-top:22px"><h3>Base cadastrada</h3><p><strong>'+state.meta.suppliers.length+' fornecedores</strong> disponíveis para seleção.</p></div><div class="manual-suppliers"><h3>Fornecedores criados manualmente</h3><p>Exclua fornecedores de teste ou cadastrados por administradores. Agendamentos anteriores permanecem no histórico.</p><div id="manualSuppliersList">Carregando fornecedores...</div></div></div>';
  updateDailyLimitPreview();
  refreshBlockedDays();
  refreshManualSuppliers();
}
function renderManualSuppliers(){
  const target=$('#manualSuppliersList');if(!target)return;
  target.innerHTML=state.manualSuppliers.length?state.manualSuppliers.map(row=>'<div class="manual-supplier-item"><strong>'+esc(row.name)+'</strong><button type="button" class="btn btn-danger" data-archive-supplier="'+row.id+'">Excluir</button></div>').join(''):'<span>Nenhum fornecedor criado manualmente.</span>';
}
async function refreshManualSuppliers(){
  try{state.manualSuppliers=(await api('/api/admin/manual-suppliers')).suppliers||[];renderManualSuppliers()}
  catch(error){const target=$('#manualSuppliersList');if(target)target.textContent=error.message;toast(error.message,true)}
}
function renderBlockedDays(){
  const target=$('#blockedDaysList');if(!target)return;
  target.innerHTML=state.blockedDays.length?state.blockedDays.map(day=>'<div class="blocked-day-item"><strong>'+dateBR(day)+'</strong><button type="button" class="btn" data-unblock-day="'+esc(day)+'" aria-label="Desbloquear '+dateBR(day)+'">Desbloquear</button></div>').join(''):'<span>Nenhuma data adicional bloqueada.</span>';
}
async function refreshBlockedDays(){
  try{state.blockedDays=(await api('/api/admin/blocked-days')).days||[];renderBlockedDays()}
  catch(error){const target=$('#blockedDaysList');if(target)target.textContent=error.message;toast(error.message,true)}
}
function openTicket(b){
  $('#ticketContent').innerHTML='<div class="ticket"><div class="ticket-header"><small>SENHA PARA ENTREGA DE MERCADORIA</small><div class="ticket-number">'+String(b.id).padStart(3,'0')+'</div></div><p class="ticket-protocol">Apresente esta senha no check-in · Protocolo AGE-'+b.id+'</p>'+
  [['Data da entrega',dateBR(b.day)],['Horário agendado',b.slot],['Filial','ATACADAO DIA A DIA S.A. · 17.457.404/0009-69'],['Endereço','ST POLO DE DESENVOLVIMENTO JK TRECHO 2/3, S/N - SANTA MARIA - BRASILIA/DF - CEP 72549-575'],['Doca','FLV'],['Fornecedor',b.supplier_name],['Número do pedido',b.order_number||'—'],['Nota fiscal',b.invoice_number||'—'],['Peso da carga',formatWeight(b.weight_kg)+' kg'],['Quantidade de itens',formatNum(b.item_count)],['Quantidade de caixas',formatNum(b.box_count)],['Tipo de veículo',b.vehicle_type],['Tipo de carga',b.cargo_type],['Situação',b.status==='active'?'Confirmado':b.status==='no_show'?'No show':'Cancelado']].map(x=>'<div class="ticket-row"><span>'+esc(x[0])+'</span><strong>'+esc(x[1])+'</strong></div>').join('')+'<p class="ticket-footer">Apresente esta senha à portaria no dia da entrega.</p></div>';
  $('#printTicket').disabled=b.status!=='active';
  $('#printTicket').title=b.status==='active'?'Imprimir senha':'Senha indisponível para impressão';
  $('#ticketModal').classList.remove('hidden');
}
function openBookingCapacityModal(){
  $('#bookingCapacityModal').classList.remove('hidden');
  $('#closeBookingCapacity').focus();
}
function closeBookingCapacityModal(){$('#bookingCapacityModal').classList.add('hidden')}
document.addEventListener('click',e=>{
  if(state.view!=='schedule'||state.user?.role!=='supplier'||state.bookingNoticeAcknowledged||!e.target.closest('#bookingForm'))return;
  e.preventDefault();e.stopImmediatePropagation();openBookingNotice(e.target);
},true);
document.addEventListener('focusin',e=>{
  if(state.view==='schedule'&&state.user?.role==='supplier'&&!state.bookingNoticeAcknowledged&&e.target.closest('#bookingForm'))openBookingNotice(e.target);
});
document.addEventListener('click',async e=>{
  if(e.target.closest('[data-booking-notice-close]')){closeBookingNotice();return}
  const unblockDay=e.target.closest('[data-unblock-day]');
  if(unblockDay){
    try{state.blockedDays=(await api('/api/admin/blocked-days','POST',{day:unblockDay.dataset.unblockDay,blocked:false})).days;renderBlockedDays();toast('Data liberada para novos agendamentos.')}
    catch(error){toast(error.message,true)}
    return;
  }
  if(e.target.closest('#notificationBell')){
    if(!$('#notificationPanel').classList.contains('hidden')){closeNotifications();return}
    await refreshNotifications();
    const unread=state.pendingNotifications.filter(u=>!state.notificationSeen.includes(String(u.id)));
    renderNotifications();
    $('#notificationPanel').classList.remove('hidden');
    $('#notificationBell').setAttribute('aria-expanded','true');
    state.notificationSeen=[...new Set([...state.notificationSeen,...unread.map(u=>String(u.id))])];
    saveNotificationSeen();
    $('#notificationCount').classList.add('hidden');
    $('#notificationBell').setAttribute('aria-label','Nenhuma nova notificação');
    return;
  }
  if(e.target.closest('[data-notification-user]')||e.target.closest('#notificationAll')){navigate('users');return}
  if(!e.target.closest('#notificationArea')&&!$('#notificationPanel').classList.contains('hidden'))closeNotifications();
  const passwordToggle=e.target.closest('[data-password-toggle]');
  if(passwordToggle){
    const input=document.getElementById(passwordToggle.dataset.passwordToggle);
    const visible=input.type==='password';
    input.type=visible?'text':'password';
    passwordToggle.setAttribute('aria-pressed',String(visible));
    passwordToggle.setAttribute('aria-label',visible?'Ocultar senha':'Mostrar senha');
    passwordToggle.classList.toggle('visible',visible);
    return;
  }
  const googleLogin=e.target.closest('[data-google-login]');
  if(googleLogin){
    googleLogin.disabled=true;
    try{await api('/api/auth/google','POST',{})}
    catch(err){googleLogin.disabled=false;toast(err.message,true)}
    return;
  }
  if(e.target.id==='toggleNewSupplier'){
    const typed=$('#regSupplierTyped');
    const selected=$('#regSupplierSelect');
    const useTyped=typed.classList.contains('hidden');
    typed.classList.toggle('hidden',!useTyped);
    selected.classList.toggle('hidden',useTyped);
    $('#regSupplierName').required=useTyped;
    $('#regSupplierName').value='';
    $('#regSupplierValue').value='';
    $('#regSupplierSelect [data-combo-label]').textContent='Selecione um fornecedor';
    e.target.textContent=useTyped?'Escolher fornecedor da lista':'Não encontrou sua empresa? Digitar nome';
    return;
  }
  const supplierBookTab=e.target.closest('[data-supplier-booktab]');
  if(supplierBookTab){state.supplierBookTab=supplierBookTab.dataset.supplierBooktab;showSupplierBookings();return}
  const deleteUser=e.target.closest('[data-delete-user]');
  if(deleteUser){
    if(!confirm('Excluir esta conta de fornecedor? O histórico de agendamentos será mantido.'))return;
    try{
      await api('/api/admin/users/'+deleteUser.dataset.deleteUser+'/delete','POST',{});
      toast('Usuário excluído.');
      await Promise.all([refreshPending(),refreshAdminUsers()]);
    }catch(err){toast(err.message,true)}
    return;
  }
  const editUser=e.target.closest('[data-edit-user]');
  if(editUser){openUserRoleModal(editUser.dataset.editUser);return}
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
  const dashboardTab=e.target.closest('[data-dashboard-tab]');if(dashboardTab){state.dashboardTab=dashboardTab.dataset.dashboardTab;renderDashboard();return}
  const zoom=e.target.closest('[data-card-zoom]');if(zoom){toggleDashboardZoom(zoom);return}
  const view=e.target.closest('[data-view]');if(view)return navigate(view.dataset.view);
  const history=e.target.closest('[data-history-open]');if(history)return openHistoryModal();
  if(e.target.closest('[data-delay-open]')){openDelayModal();return}
  const delaySupplier=e.target.closest('[data-delay-index]');if(delaySupplier){openDelayDetail(Number(delaySupplier.dataset.delayIndex));return}
  const performanceSupplier=e.target.closest('[data-performance-supplier]');if(performanceSupplier){openDelayDetail(Number(performanceSupplier.dataset.performanceSupplier));return}
  const arrivalTab=e.target.closest('[data-arrival-tab]');if(arrivalTab){state.arrivalTab=arrivalTab.dataset.arrivalTab;renderArrivalTab();return}
  if(e.target.closest('[data-unscheduled-open]')){try{await openUnscheduledArrivalModal()}catch(error){toast(error.message,true)}return}
  const arrivalNoShow=e.target.closest('[data-arrival-no-show]');
  if(arrivalNoShow){
    if(!confirm('Confirmar No show? Este fornecedor não terá horário de chegada registrado para o agendamento.'))return;
    try{await api('/api/arrivals/'+arrivalNoShow.dataset.arrivalNoShow+'/no-show','POST',{});toast('Agendamento marcado como No show.');await refreshArrivals()}
    catch(error){toast(error.message,true)}
    return;
  }
  const dailySummary=e.target.closest('[data-dashboard-day]');if(dailySummary){openDashboardDayModal(dailySummary.dataset.dashboardDay);return}
  const dashboardPage=e.target.closest('[data-dashboard-page]');if(dashboardPage){state.dashboardDayPage=Number(dashboardPage.dataset.dashboardPage);renderDashboardDayPage();return}
  const bookingSlot=e.target.closest('[data-booking-slot]');
  if(bookingSlot){state.selectedSlot=bookingSlot.dataset.bookingSlot;renderAvailableSlots();return}
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
  const markNoShow=e.target.closest('[data-no-show]');
  if(markNoShow){if(!confirm('Confirmar que o fornecedor não compareceu? O agendamento será marcado como No show.'))return;try{await api('/api/bookings/'+markNoShow.dataset.noShow+'/no-show','POST',{});toast('Agendamento marcado como No show.');await refreshBookings()}catch(err){toast(err.message,true)}return}
  const approve=e.target.closest('[data-approve]');
  if(approve){try{const role=approve.closest('.pending-item').querySelector('[data-approve-role]').value;await api('/api/admin/users/'+approve.dataset.approve+'/approve','POST',{role});toast('Acesso de '+roleNames[role].toLowerCase()+' aprovado.');await Promise.all([refreshPending(),refreshAdminUsers()]);state.meta=await api('/api/meta')}catch(err){toast(err.message,true)}return}
  const archive=e.target.closest('[data-archive-supplier]');
  if(archive){
    const supplier=state.manualSuppliers.find(row=>String(row.id)===archive.dataset.archiveSupplier);
    if(!supplier||!confirm('Excluir '+supplier.name+' da lista de fornecedores disponíveis?'))return;
    try{await api('/api/admin/manual-suppliers/'+supplier.id+'/archive','POST',{});state.meta=await api('/api/meta');await refreshManualSuppliers();const count=$('.admin-supplier-card .info-panel strong');if(count)count.textContent=state.meta.suppliers.length+' fornecedores';toast('Fornecedor excluído da lista de seleção.')}
    catch(error){toast(error.message,true)}
    return;
  }
  if(e.target.id==='applyBookings'){
    state.bookFrom=$('#bookFrom').value;state.bookTo=$('#bookTo').value;state.bookSupplier=$('#bookSupplier')?.value||'';
    return refreshBookings();
  }
  if(e.target.id==='menuBtn'){$('#sidebar').classList.add('open');$('#mobileOverlay').classList.add('show')}
  if(e.target.id==='mobileOverlay'){$('#sidebar').classList.remove('open');$('#mobileOverlay').classList.remove('show')}
  if(e.target.id==='closeTicket'||e.target.id==='ticketModal')$('#ticketModal').classList.add('hidden');
  if(e.target.id==='closeDashboardDay'||e.target.id==='dashboardDayModal')closeDashboardDayModal();
  if(e.target.id==='closeDelayDetail'||e.target.id==='delayDetailModal'){state.delayDetailRequest++;$('#delayDetailModal').classList.add('hidden')}
  if(e.target.id==='closeDelayModal'||e.target.id==='delayModal')closeDelayModal();
  if(e.target.closest('#printDashboardDay')){printDashboardDay();return}
  if(e.target.id==='closeBookingCapacity'||e.target.id==='bookingCapacityModal'||e.target.closest('[data-capacity-close]'))closeBookingCapacityModal();
  if(e.target.id==='closeHistory'||e.target.id==='cancelHistory'||e.target.id==='historyModal')closeHistoryModal();
  if(e.target.id==='closeUserRole'||e.target.id==='cancelUserRole'||e.target.id==='userRoleModal')closeUserRoleModal();
  if(e.target.id==='closeUnscheduledArrival'||e.target.id==='cancelUnscheduledArrival'||e.target.id==='unscheduledArrivalModal')closeUnscheduledArrivalModal();
  if(e.target.id==='printTicket')window.print();
  if(e.target.id==='logoutBtn'){await api('/api/logout','POST',{});state.user=null;showAuth('login')}
});
document.addEventListener('input',e=>{
  if(e.target.matches('form[data-arrival-form] input[name="arrival_time"]'))updateArrivalSubmit(e.target);
  if(e.target.id==='userSearch'){state.userSearch=e.target.value;renderAdminUserRows();return}
  if(e.target.matches('[data-combo-search]'))renderComboResults(e.target.closest('[data-supplier-combo]'),e.target.value);
  if(['scheduleStart','scheduleEnd','scheduleCapacity'].includes(e.target.id))updateDailyLimitPreview();
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshNotifications()});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeDashboardZoom();closeNotifications();closeSupplierCombos();closeHistoryModal();closeUserRoleModal();closeUnscheduledArrivalModal();closeBookingCapacityModal();closeBookingNotice();closeDashboardDayModal();closeDelayModal();return}
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
  if(e.target.matches('form[data-arrival-form] input[name="arrival_time"]')){updateArrivalSubmit(e.target);return}
  if(e.target.id==='userRoleFilter'){state.userRoleFilter=e.target.value;renderAdminUserRows();return}
  if(e.target.id==='arrivalDay'){state.arrivalDay=e.target.value||today();refreshArrivals();return}
  if(['delayFrom','delayTo'].includes(e.target.id)){
    state.delayFrom=$('#delayFrom').value;state.delayTo=$('#delayTo').value;
    state.delayDetailRequest++;$('#delayDetailModal').classList.add('hidden');
    refreshDelaySummary();return;
  }
  if(['dashFrom','dashTo','dashSupplier'].includes(e.target.id)&&state.view==='dashboard'){
    state.dashFrom=$('#dashFrom').value;state.dashTo=$('#dashTo').value;state.dashSupplier=$('#dashSupplier')?.value||'';
    const feedback=$('#dashFilterFeedback');
    if(state.dashFrom>state.dashTo){if(feedback)feedback.textContent='A data inicial deve ser anterior à data final.';return}
    if(feedback)feedback.textContent='Atualizando resultados automaticamente...';
    return renderDashboard();
  }
  if(e.target.id==='bookingDay'){
    if(!e.target.value)return;
    const minimum=firstAvailableDeliveryDay();
    if(e.target.value<minimum){e.target.value=minimum;state.slotDay=minimum;state.selectedSlot='';refreshAvailableSlots(state.slotDay);toast('O agendamento deve ser feito a partir do próximo dia disponível.',true);return}
    if(isSunday(e.target.value)){const next=nextOpenDay(dateOffset(e.target.value,1));e.target.value=next;state.slotDay=next;state.selectedSlot='';refreshAvailableSlots(state.slotDay);toast('Domingos não recebem agendamentos. Selecionamos '+dateBR(next)+'.',true);return}
    state.slotDay=e.target.value;
    state.selectedSlot='';
    refreshAvailableSlots(state.slotDay);
  }
  if(e.target.id==='userRole'||e.target.id==='userRoleSupplierMode')updateUserRoleSupplierVisibility();
  if(e.target.id==='scheduleInterval')updateDailyLimitPreview();
});
document.addEventListener('submit',async e=>{
  const form=e.target;
  if(!form.hasAttribute('data-arrival-form')&&!['bootstrapForm','registerForm','loginForm','bookingForm','blockedDayForm','supplierForm','historyForm','schedulingForm','userRoleForm','unscheduledArrivalForm'].includes(form.id))return;
  e.preventDefault();
  if(form.id==='bookingForm'&&state.user?.role==='supplier'&&!state.bookingNoticeAcknowledged){openBookingNotice(form.querySelector('button[type="submit"]'));return}
  if(form.hasAttribute('data-arrival-form')){
    const input=form.querySelector('input[name="arrival_time"]');
    if(!input?.value||!input.validity.valid){input?.reportValidity();toast('Informe o horário de chegada antes de registrar.',true);return}
  }
  submitButton(form,true);
  const values=Object.fromEntries(new FormData(form));
  try{
    if(form.hasAttribute('data-arrival-form')){
      await api('/api/arrivals/'+form.dataset.arrivalForm,'POST',{arrival_time:values.arrival_time});
      toast('Horário de chegada registrado.');
      await refreshArrivals();
    }
    if(form.id==='unscheduledArrivalForm'){
      if(!values.supplier_id)throw new Error('Selecione o fornecedor.');
      await api('/api/arrivals/unscheduled','POST',values);
      closeUnscheduledArrivalModal();
      state.arrivalDay=values.day;state.arrivalTab='unscheduled';
      const arrivalDayField=$('#arrivalDay');if(arrivalDayField)arrivalDayField.value=values.day;
      toast('Veículo fora da agenda registrado.');
      if(state.view==='arrivals')await refreshArrivals();
    }
    if(form.id==='bootstrapForm'){
      const r=await api('/api/bootstrap','POST',values);
      state.user=r.user;state.meta.bootstrap=false;toast('Administrador criado.');showApp();
    }
    if(form.id==='registerForm'){
      if(!values.supplier_id && !values.supplier_name?.trim())throw new Error('Selecione ou digite um fornecedor.');
      const r=await api('/api/register','POST',values);
      showRegistrationReceived(r.message);
    }
    if(form.id==='loginForm'){
      const r=await api('/api/login','POST',values);
      state.user=r.user;showApp();
    }
    if(form.id==='bookingForm'){
      if(state.user.role==='admin'&&!values.supplier_id)throw new Error('Selecione um fornecedor.');
      if(state.user.role==='supplier'&&(!state.user.supplier_id||!state.user.supplier_name))throw new Error('Seu usuário está sem fornecedor vinculado. Peça ao administrador para corrigir o cadastro antes de agendar.');
      if(!values.day||values.day<firstAvailableDeliveryDay()||isSunday(values.day))throw new Error('Escolha uma data a partir do próximo dia disponível. Domingos não recebem agendamentos.');
      if(!values.slot||!state.availableSlots.includes(values.slot))throw new Error('Selecione um horário disponível antes de confirmar.');
      values.weight_kg=Number(values.weight_kg);
      values.item_count=Number(values.item_count);
      values.box_count=values.box_count===''||values.box_count==null?0:Number(values.box_count);
      const r=await api('/api/bookings','POST',values);
      toast('Agendamento confirmado para '+r.booking.slot+'.');
      openTicket(r.booking);
      state.selectedSlot='';
      state.bookingNoticeAcknowledged=false;
      renderSchedule();
    }
    if(form.id==='blockedDayForm'){
      if(!values.day||values.day<=today()||isSunday(values.day))throw new Error('Escolha uma data futura de segunda a sábado.');
      state.blockedDays=(await api('/api/admin/blocked-days','POST',{day:values.day,blocked:true})).days;
      renderBlockedDays();form.reset();toast('Data bloqueada para novos agendamentos.');
    }
    if(form.id==='supplierForm'){
      const r=await api('/api/admin/suppliers','POST',values);
      state.meta.suppliers.push(r.supplier);
      state.meta.suppliers.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
      toast('Fornecedor cadastrado.');
      await renderAdmin();
    }
    if(form.id==='schedulingForm'){
      values.interval_minutes=Number(values.interval_minutes);
      values.vehicles_per_slot=Number(values.vehicles_per_slot);
      values.daily_vehicle_limit=Number(values.daily_vehicle_limit);
      const result=await api('/api/admin/settings','POST',values);
      state.meta.scheduling=result.scheduling;
      toast('Sistemática atualizada para todos os fornecedores.');
      await renderAdmin();
    }
    if(form.id==='userRoleForm'){
      const creating=values.role==='supplier'&&$('#userRoleSupplierMode').value==='new';
      if(creating){values.supplier_id=null;values.supplier_name=String(values.supplier_name||'').trim().replace(/\s+/g,' ');if(values.supplier_name.length<3)throw new Error('Informe a razão social do novo fornecedor.');}
      else{values.supplier_name='';if(values.role==='supplier'&&!values.supplier_id)throw new Error('Selecione um fornecedor para este usuário.');}
      values.supplier_id=values.supplier_id?Number(values.supplier_id):null;
      await api('/api/admin/users/'+state.editingUser.id+'/role','POST',values);
      closeUserRoleModal();
      toast('Perfil do usuário atualizado.');
      await refreshAdminUsers();
      state.meta=await api('/api/meta');
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
  }catch(err){
    const message=String(err.message||'');
    const normalized=message.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    if(form.id==='bookingForm'&&normalized.includes('bloquead')){state.selectedSlot='';refreshAvailableSlots(state.slotDay);toast(message,true)}
    else if(form.id==='bookingForm'&&normalized.includes('horario selecionado')){state.selectedSlot='';refreshAvailableSlots(state.slotDay);toast('Esse horário acabou de ser preenchido. Selecione outro horário disponível.',true)}
    else if(form.id==='bookingForm'&&((normalized.includes('limite de ')&&normalized.includes('veiculos'))||normalized.includes('todos os horarios')||normalized.includes('horarios desta data')))openBookingCapacityModal();
    else toast(message,true);
  }
  finally{if(form.isConnected){submitButton(form,false);if(form.hasAttribute('data-arrival-form'))updateArrivalSubmit(form.querySelector('input[name="arrival_time"]'))}}
});
(async()=>{try{state.meta=await api('/api/meta');const session=await api('/api/me');state.user=session.user;if(state.user)showApp();else if(session.pending)showRegistrationReceived('Seu cadastro está aguardando a aprovação da equipe.');else showAuth()}catch(e){$('#authContent').innerHTML='<div class="auth-inner"><h2>Não foi possível carregar o portal</h2><p class="subtext">'+esc(e.message)+'</p><button class="btn" onclick="location.reload()">Tentar novamente</button></div>'}})();
