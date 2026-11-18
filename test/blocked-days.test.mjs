import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.FLV_TEST_MODE='1';
const { server }=await import('../server.js');
async function call(method,url,body,cookie=''){
  return new Promise((resolve,reject)=>{
    const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);
    req.method=method;req.url=url;req.headers={host:'localhost:3100',cookie,origin:'http://localhost:3100'};
    const res={status:200,headers:{},writeHead(status,headers){this.status=status;this.headers=headers},
      end(text){try{resolve({status:this.status,data:JSON.parse(text||'{}'),headers:this.headers})}catch(error){reject(error)}}};
    server.emit('request',req,res);
  });
}
const cookieOf=response=>response.headers['set-cookie'].split(';')[0];
try{
  const supplier=(await call('GET','/api/meta')).data.suppliers[0];
  const adminCookie=cookieOf(await call('POST','/api/bootstrap',{name:'Admin',email:'admin@local.test',password:'123456'}));
  await call('POST','/api/register',{name:'Fornecedor',email:'supplier@local.test',password:'123456',supplier_id:supplier.id});
  const pending=(await call('GET','/api/admin/pending',undefined,adminCookie)).data.users[0];
  assert.equal((await call('POST','/api/admin/users/'+pending.id+'/approve',{role:'supplier'},adminCookie)).status,200);
  const supplierCookie=cookieOf(await call('POST','/api/login',{email:'supplier@local.test',password:'123456'}));
  const target=new Date();target.setUTCDate(target.getUTCDate()+14);
  while(target.getUTCDay()===0)target.setUTCDate(target.getUTCDate()+1);
  const day=target.toISOString().slice(0,10);
  const booking={day,slot:'05:00',weight_kg:100,item_count:2,box_count:0,vehicle_type:'VUC',cargo_type:'Paletizada'};
  assert.equal((await call('GET','/api/admin/blocked-days',undefined,supplierCookie)).status,403);
  assert.equal((await call('POST','/api/admin/blocked-days',{day,blocked:true},supplierCookie)).status,403);
  assert.equal((await call('POST','/api/bookings',booking,supplierCookie)).status,200);
  const blocked=await call('POST','/api/admin/blocked-days',{day,blocked:true},adminCookie);
  assert.equal(blocked.status,200);
  assert.deepEqual(blocked.data.days,[day]);
  const availability=await call('GET','/api/availability?day='+day,undefined,supplierCookie);
  assert.deepEqual(availability.data,{slots:[],blocked:true});
  const denied=await call('POST','/api/bookings',{...booking,slot:'06:00'},supplierCookie);
  assert.equal(denied.status,409);
  assert.match(denied.data.error,/bloqueados/i);
  assert.equal((await call('GET','/api/bookings?from='+day+'&to='+day,undefined,supplierCookie)).data.bookings.length,1);
  assert.equal((await call('POST','/api/admin/blocked-days',{day,blocked:false},adminCookie)).status,200);
  assert.equal((await call('GET','/api/availability?day='+day,undefined,supplierCookie)).data.blocked,false);
  assert.equal((await call('POST','/api/bookings',{...booking,slot:'06:00'},supplierCookie)).status,200);
  console.log('PASS: bloqueio administrativo impede novas reservas e preserva as existentes');
}finally{server.close()}
