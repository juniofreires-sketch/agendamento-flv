import { createClient } from '@supabase/supabase-js';

const supabase = createClient(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
const vehicleTypes = ['3/4','BITREM','CARRETA 24','CARRETA 26','CARRETA 28','CARRETA 30','FIORINO','TOCO','TRUCK','VUC'];
const cargoTypes = ['Batida / Paletizada','Carga batida','Paletizada','Pallet sobreposto'];
const fail = error => {
  if (!error) return;
  const messages = {
    invalid_credentials: 'Email ou senha incorretos.',
    email_not_confirmed: 'Confirme o email recebido antes de entrar.',
    user_already_exists: 'Este email já está cadastrado.'
  };
  throw new Error(messages[error.code] || error.message || 'Não foi possível concluir a operação.');
};
const localParts = () => {
  const now = new Date();
  return {
    day: new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),
    time: new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now)
  };
};
const bookingRow = row => ({
  ...row,
  day: row.day,
  slot: String(row.slot).slice(0,5),
  supplier_name: row.suppliers?.name || ''
});
const bookingSelect = 'id,supplier_id,user_id,day,slot,order_number,invoice_number,weight_kg,item_count,box_count,vehicle_type,cargo_type,status,created_at,cancelled_at,suppliers(name)';
async function profileFor(user){
  const {data,error}=await supabase.from('profiles')
    .select('id,name,email,role,status,supplier_id,requested_supplier_name,suppliers(name)')
    .eq('id',user.id).single();
  fail(error);
  if(!data) return null;
  return {
    id:data.id,name:data.name,email:data.email,role:data.role,status:data.status,
    supplier_id:data.supplier_id,supplier_name:data.suppliers?.name || data.requested_supplier_name || null
  };
}
async function signedInProfile(){
  const {data,error}=await supabase.auth.getUser();
  if(error || !data?.user) return null;
  return profileFor(data.user);
}
function endpointId(path){
  const m=/^\/api\/bookings\/(\d+)(?:\/cancel)?$/.exec(path);
  return m ? Number(m[1]) : null;
}
export async function api(path,method='GET',body){
  const url=new URL(path,location.origin);
  const p=url.pathname;
  if(p==='/api/meta'&&method==='GET'){
    const [{data,error},settings]=await Promise.all([
      supabase.from('suppliers').select('id,name').order('name').limit(1000),
      fetch(__SUPABASE_URL__+'/auth/v1/settings',{headers:{apikey:__SUPABASE_PUBLISHABLE_KEY__}})
        .then(response=>response.ok?response.json():null).catch(()=>null)
    ]);
    fail(error);
    const now=localParts();
    return {suppliers:data||[],vehicleTypes,cargoTypes,bootstrap:false,googleEnabled:settings?.external?.google===true,today:now.day,current_time:now.time};
  }
  if(p==='/api/me'&&method==='GET'){
    const user=await signedInProfile();
    if(user?.status==='pending'){
      await supabase.auth.signOut();
      return {user:null,pending:true};
    }
    return {user:user?.status==='active'?user:null};
  }
  if(p==='/api/auth/google'&&method==='POST'){
    const {error}=await supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin}});
    fail(error);
    return {ok:true};
  }
  if(p==='/api/register'&&method==='POST'){
    const email=String(body.email||'').trim().toLowerCase();
    if(email==='junior.matheus64@gmail.com')throw new Error('Este email já está reservado para a administração.');
    const supplierName=String(body.supplier_name||'').trim().replace(/\s+/g,' ');
    if(!body?.supplier_id && (supplierName.length<3 || supplierName.length>160))
      throw new Error('Selecione um fornecedor ou digite o nome da empresa.');
    const {data,error}=await supabase.auth.signUp({
      email,
      password:String(body.password||''),
      options:{data:{name:String(body.name||'').trim(),supplier_id:body.supplier_id?Number(body.supplier_id):null,supplier_name:body.supplier_id?null:supplierName}}
    });
    fail(error);
    if(data.session)await supabase.auth.signOut();
    return {message:'Cadastro recebido! Nossa equipe avaliará seus dados. Após a aprovação do administrador, você poderá acessar o portal.'};
  }
  if(p==='/api/login'&&method==='POST'){
    const {data,error}=await supabase.auth.signInWithPassword({
      email:String(body.email||'').trim().toLowerCase(),
      password:String(body.password||'')
    });
    fail(error);
    const user=await profileFor(data.user);
    if(user?.status!=='active'){
      await supabase.auth.signOut();
      throw new Error('Seu cadastro está aguardando aprovação do administrador.');
    }
    return {user};
  }
  if(p==='/api/logout'&&method==='POST'){
    const {error}=await supabase.auth.signOut();fail(error);return {ok:true};
  }
  if(p==='/api/bookings'&&method==='GET'){
    const from=url.searchParams.get('from')||'0001-01-01';
    const to=url.searchParams.get('to')||'9999-12-31';
    let query=supabase.from('bookings').select(bookingSelect)
      .gte('day',from).lte('day',to)
      .order('day',{ascending:false}).order('slot',{ascending:false}).order('id',{ascending:false})
      .limit(2000);
    const supplier=url.searchParams.get('supplier_id');
    if(supplier)query=query.eq('supplier_id',Number(supplier));
    const {data,error}=await query;fail(error);
    return {bookings:(data||[]).map(bookingRow)};
  }
  if(p==='/api/bookings'&&method==='POST'){
    const payload={
      supplier_id:body.supplier_id ? Number(body.supplier_id) : null,
      day:body.day,
      order_number:body.order_number||null,
      invoice_number:body.invoice_number||null,
      weight_kg:Number(body.weight_kg),
      item_count:Number(body.item_count),
      box_count:Number(body.box_count),
      vehicle_type:body.vehicle_type,
      cargo_type:body.cargo_type
    };
    const {data,error}=await supabase.from('bookings').insert(payload).select(bookingSelect).single();
    fail(error);return {booking:bookingRow(data)};
  }
  const id=endpointId(p);
  if(id && method==='GET' && !p.endsWith('/cancel')){
    const {data,error}=await supabase.from('bookings').select(bookingSelect).eq('id',id).single();
    fail(error);return {booking:bookingRow(data)};
  }
  if(id && method==='POST' && p.endsWith('/cancel')){
    const {data,error}=await supabase.from('bookings').update({status:'cancelled'}).eq('id',id).select(bookingSelect).single();
    fail(error);return {booking:bookingRow(data)};
  }
  if(p==='/api/admin/pending'&&method==='GET'){
    const {data,error}=await supabase.from('profiles')
      .select('id,name,email,created_at,requested_supplier_name,suppliers(name)')
      .eq('status','pending').eq('role','supplier').order('created_at');
    fail(error);
    return {users:(data||[]).map(row=>({...row,supplier_name:row.suppliers?.name||row.requested_supplier_name||''}))};
  }
  if(p==='/api/admin/users'&&method==='GET'){
    const {data,error}=await supabase.from('profiles')
      .select('id,name,email,status,created_at,requested_supplier_name,suppliers(name)')
      .eq('role','supplier').order('created_at',{ascending:false}).limit(2000);
    fail(error);
    return {users:(data||[]).map(row=>({...row,supplier_name:row.suppliers?.name||row.requested_supplier_name||''}))};
  }
  const approve=/^\/api\/admin\/users\/([a-f0-9-]+)\/approve$/.exec(p);
  if(approve&&method==='POST'){
    const {data,error}=await supabase.from('profiles').update({status:'active'})
      .eq('id',approve[1]).eq('status','pending').eq('role','supplier').select('id').single();
    fail(error);if(!data)throw new Error('Cadastro pendente não encontrado.');
    return {ok:true};
  }
  const remove=/^\/api\/admin\/users\/([a-f0-9-]+)\/delete$/.exec(p);
  if(remove&&method==='POST'){
    const {error}=await supabase.rpc('admin_delete_supplier_user',{p_user_id:remove[1]});
    fail(error);return {ok:true};
  }
  if(p==='/api/admin/suppliers'&&method==='POST'){
    const name=String(body.name||'').trim().replace(/\s+/g,' ');
    const {data,error}=await supabase.from('suppliers').insert({name}).select('id,name').single();
    fail(error);return {supplier:data};
  }
  throw new Error('Operação não disponível.');
}
