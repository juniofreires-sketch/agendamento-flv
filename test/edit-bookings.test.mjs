import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.FLV_TEST_MODE='1';
process.env.FLV_TEST_NOW='2026-11-23T12:00:00Z';
const {server}=await import('../server.js');
async function call(method,url,body,cookie=''){
  return new Promise((resolve,reject)=>{
    const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);
    req.method=method;req.url=url;req.headers={host:'localhost:3100',cookie,origin:'http://localhost:3100'};
    const res={status:200,headers:{},writeHead(status,headers){this.status=status;this.headers=headers},end(text){try{resolve({status:this.status,headers:this.headers,data:JSON.parse(text||'{}')})}catch(error){reject(error)}}};
    server.emit('request',req,res);
  });
}
const cookie=response=>response.headers['set-cookie'].split(';')[0];
try{
  const suppliers=(await call('GET','/api/meta')).data.suppliers;
  const admin=cookie(await call('POST','/api/bootstrap',{name:'Admin',email:'admin@edit.test',password:'12345678'}));
  for(const [email,supplier] of [['first@edit.test',suppliers[0]],['second@edit.test',suppliers[1]]]){
    assert.equal((await call('POST','/api/register',{name:'Fornecedor',email,password:'12345678',supplier_id:supplier.id})).status,201);
  }
  for(const user of (await call('GET','/api/admin/pending',undefined,admin)).data.users)
    assert.equal((await call('POST','/api/admin/users/'+user.id+'/approve',{},admin)).status,200);
  const first=cookie(await call('POST','/api/login',{email:'first@edit.test',password:'12345678'}));
  const second=cookie(await call('POST','/api/login',{email:'second@edit.test',password:'12345678'}));
  const data={day:'2026-11-24',slot:'05:00',order_number:'A',invoice_number:'1',weight_kg:100,item_count:2,box_count:0,vehicle_type:'VUC',cargo_type:'Paletizada'};
  const made=await call('POST','/api/bookings',data,first);
  assert.equal(made.status,200);
  const id=made.data.booking.id;
  assert.equal((await call('GET',`/api/bookings/${id}/edit-slots?day=2026-11-24`,undefined,first)).data.slots.includes('05:00'),true);
  assert.equal((await call('PATCH',`/api/bookings/${id}`,{...data,weight_kg:250},second)).status,404);
  assert.equal((await call('PATCH',`/api/bookings/${id}`,{...data,weight_kg:250},admin)).status,403);
  assert.equal((await call('PATCH',`/api/bookings/${id}`,{...data,day:'2026-11-22'},first)).status,400);
  assert.equal((await call('PATCH',`/api/bookings/${id}`,{...data,day:'2026-11-29'},first)).status,400);
  assert.equal((await call('PATCH',`/api/bookings/${id}`,{...data,day:'2026-11-23'},first)).status,400);
  assert.equal((await call('POST','/api/admin/blocked-days',{day:'2026-11-26',blocked:true},admin)).status,200);
  assert.equal((await call('PATCH',`/api/bookings/${id}`,{...data,day:'2026-11-26'},first)).status,409);
  const changed=await call('PATCH',`/api/bookings/${id}`,{...data,day:'2026-11-25',slot:'06:00',weight_kg:250,box_count:5},first);
  assert.equal(changed.status,200);
  assert.equal(changed.data.booking.id,id);
  assert.equal(changed.data.booking.day,'2026-11-25');
  assert.equal(changed.data.booking.weight_kg,250);
  assert.equal(changed.data.booking.supplier_id,suppliers[0].id);
  const todayBooking=await call('POST','/api/bookings',{...data,slot:'07:00'},first);
  assert.equal(todayBooking.status,200);
  process.env.FLV_TEST_NOW='2026-11-24T09:00:00Z';
  const sameDay=await call('PATCH',`/api/bookings/${todayBooking.data.booking.id}`,{...data,slot:'08:00',weight_kg:175},first);
  assert.equal(sameDay.status,200);
  assert.equal(sameDay.data.booking.day,'2026-11-24');
  assert.equal(sameDay.data.booking.slot,'08:00');
  process.env.FLV_TEST_NOW='2026-11-26T12:00:00Z';
  assert.equal((await call('PATCH',`/api/bookings/${id}`,{...data,day:'2026-11-27'},first)).status,409);
  console.log('PASS: edição isolada por fornecedor, datas, bloqueios e agendamento anterior');
}finally{
  delete process.env.FLV_TEST_NOW;
  server.close();
}
