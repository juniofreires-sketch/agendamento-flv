import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
process.env.FLV_TEST_MODE='1';
process.env.FLV_TEST_NOW='2026-11-10T15:00:00Z';
const {server}=await import('../server.js');
async function call(method,url,body,cookie=''){
  return new Promise((resolve,reject)=>{
    const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);
    req.method=method;req.url=url;req.headers={host:'localhost:3100',cookie,origin:'http://localhost:3100'};
    const res={status:200,headers:{},writeHead(status,headers){this.status=status;this.headers=headers},end(text){try{resolve({status:this.status,headers:this.headers,data:JSON.parse(text||'{}')})}catch(error){reject(error)}}};
    server.emit('request',req,res);
  });
}
const cookieOf=response=>response.headers['set-cookie'].split(';')[0];
try{
  const supplier=(await call('GET','/api/meta')).data.suppliers[0];
  const adminCookie=cookieOf(await call('POST','/api/bootstrap',{name:'Admin',email:'admin@local.test',password:'123456'}));
  for(const [name,email] of [['CD','cd@local.test'],['Comercial','commercial@local.test'],['Fornecedor','supplier@local.test']]){
    assert.equal((await call('POST','/api/register',{name,email,password:'123456',supplier_id:supplier.id})).status,201);
  }
  const pending=(await call('GET','/api/admin/pending',undefined,adminCookie)).data.users;
  for(const user of pending){
    const role=user.name==='CD'?'cd':user.name==='Comercial'?'commercial':'supplier';
    assert.equal((await call('POST','/api/admin/users/'+user.id+'/approve',{role},adminCookie)).status,200);
  }
  const cdCookie=cookieOf(await call('POST','/api/login',{email:'cd@local.test',password:'123456'}));
  const commercialCookie=cookieOf(await call('POST','/api/login',{email:'commercial@local.test',password:'123456'}));
  const supplierCookie=cookieOf(await call('POST','/api/login',{email:'supplier@local.test',password:'123456'}));
  const day='2026-11-18';
  const booking=await call('POST','/api/bookings',{supplier_id:supplier.id,day,slot:'05:00',weight_kg:100,item_count:1,box_count:0,vehicle_type:'VUC',cargo_type:'Paletizada'},adminCookie);
  assert.equal(booking.status,200);
  process.env.FLV_TEST_NOW='2026-11-19T15:00:00Z';
  assert.equal((await call('POST','/api/arrivals/unscheduled',{supplier_id:supplier.id,day,arrival_time:'08:30'},supplierCookie)).status,403);
  assert.equal((await call('POST','/api/arrivals/unscheduled',{supplier_id:supplier.id,day,arrival_time:'08:30'},commercialCookie)).status,403);
  assert.equal((await call('GET','/api/arrivals/unscheduled?day='+day,undefined,commercialCookie)).status,403);
  assert.equal((await call('POST','/api/arrivals/unscheduled',{supplier_id:supplier.id,day:'2026-11-20',arrival_time:'08:30'},cdCookie)).status,400);
  assert.equal((await call('POST','/api/arrivals/unscheduled',{supplier_id:supplier.id,day:'2026-11-19',arrival_time:'13:00'},cdCookie)).status,400);
  assert.equal((await call('POST','/api/arrivals/unscheduled',{supplier_id:supplier.id,day,arrival_time:''},cdCookie)).status,400);
  assert.equal((await call('POST','/api/arrivals/unscheduled',{supplier_id:supplier.id,day,arrival_time:'08:30'},cdCookie)).status,201);
  assert.equal((await call('POST','/api/arrivals/unscheduled',{supplier_id:supplier.id,day,arrival_time:'09:15'},adminCookie)).status,201);
  const rows=(await call('GET','/api/arrivals/unscheduled?day='+day,undefined,cdCookie)).data.arrivals;
  assert.deepEqual(rows.map(row=>row.arrival_time),['08:30','09:15']);
  const summary=await call('GET','/api/dashboard/unscheduled-arrivals?from='+day+'&to=2026-11-30',undefined,commercialCookie);
  assert.equal(summary.status,200);
  assert.deepEqual([summary.data.scheduled,summary.data.unscheduled,summary.data.unscheduled_percent],[1,2,66.7]);
  assert.deepEqual([summary.data.top_suppliers[0].supplier_id,summary.data.top_suppliers[0].percent],[supplier.id,66.7]);
  assert.equal((await call('GET','/api/dashboard/unscheduled-arrivals?from='+day+'&to='+day,undefined,supplierCookie)).status,403);
  const performance=(await call('GET','/api/dashboard/arrival-performance?from='+day+'&to='+day,undefined,adminCookie)).data;
  assert.deepEqual([performance.totals.scheduled,performance.totals.recorded,performance.totals.late],[1,0,0]);
  console.log('PASS: veículos sem agenda, permissões, validação, comparação e isolamento de atrasos');
}finally{delete process.env.FLV_TEST_NOW;server.close()}
