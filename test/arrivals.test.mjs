import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.FLV_TEST_MODE='1';
const { server }=await import('../server.js');
async function call(method,url,body,cookie=''){
  return new Promise((resolve,reject)=>{
    const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);
    req.method=method;req.url=url;req.headers={host:'localhost:3100',cookie,origin:'http://localhost:3100'};
    const res={status:200,headers:{},writeHead(status,headers){this.status=status;this.headers=headers},
      end(text){try{resolve({status:this.status,headers:this.headers,data:JSON.parse(text||'{}')})}catch(error){reject(error)}}};
    server.emit('request',req,res);
  });
}
const cookieOf=response=>response.headers['set-cookie'].split(';')[0];
const openDay=day=>{let date=new Date(day+'T12:00:00Z');while(date.getUTCDay()===0)date.setUTCDate(date.getUTCDate()+1);return date.toISOString().slice(0,10)};
try{
  const supplier=(await call('GET','/api/meta')).data.suppliers[0];
  const admin=await call('POST','/api/bootstrap',{name:'Admin',email:'admin@local.test',password:'123456'});
  const adminCookie=cookieOf(admin);
  for(const [name,email] of [['Fornecedor','supplier@local.test'],['CD','cd@local.test'],['Comercial','commercial@local.test']]){
    assert.equal((await call('POST','/api/register',{name,email,password:'123456',supplier_id:supplier.id})).status,201);
  }
  const pending=(await call('GET','/api/admin/pending',undefined,adminCookie)).data.users;
  for(const user of pending){
    const role=user.name==='CD'?'cd':user.name==='Comercial'?'commercial':'supplier';
    assert.equal((await call('POST','/api/admin/users/'+user.id+'/approve',{role},adminCookie)).status,200);
  }
  const cdCookie=cookieOf(await call('POST','/api/login',{email:'cd@local.test',password:'123456'}));
  const supplierCookie=cookieOf(await call('POST','/api/login',{email:'supplier@local.test',password:'123456'}));
  const commercialCookie=cookieOf(await call('POST','/api/login',{email:'commercial@local.test',password:'123456'}));
  assert.equal((await call('GET','/api/dashboard',undefined,cdCookie)).status,200);
  assert.equal((await call('GET','/api/bookings',undefined,cdCookie)).status,403);
  assert.equal((await call('GET','/api/arrivals',undefined,commercialCookie)).status,403);
  assert.equal((await call('GET','/api/arrivals',undefined,supplierCookie)).status,403);

  const start=new Date();start.setUTCDate(start.getUTCDate()+14);
  const day1=openDay(start.toISOString().slice(0,10));
  const after=new Date(day1+'T12:00:00Z');after.setUTCDate(after.getUTCDate()+1);
  const day2=openDay(after.toISOString().slice(0,10));
  const after2=new Date(day2+'T12:00:00Z');after2.setUTCDate(after2.getUTCDate()+1);
  const day3=openDay(after2.toISOString().slice(0,10));
  const make=async(day,slot)=>{
    const response=await call('POST','/api/bookings',{supplier_id:supplier.id,day,slot,weight_kg:100,item_count:2,box_count:3,vehicle_type:'VUC',cargo_type:'Paletizada'},adminCookie);
    assert.equal(response.status,200);return response.data.booking.id;
  };
  const ids=[await make(day1,'05:00'),await make(day1,'06:00'),await make(day2,'07:00')];
  const pendingId=await make(day2,'08:00');
  const futureId=await make(day3,'09:00');
  assert.equal((await call('POST','/api/arrivals/'+ids[0],{arrival_time:'05:30'},cdCookie)).status,400);
  assert.equal((await call('POST','/api/arrivals/'+pendingId+'/no-show',{},cdCookie)).status,400);
  process.env.FLV_TEST_NOW=day2+'T18:00:00Z';
  assert.equal((await call('POST','/api/arrivals/'+futureId+'/no-show',{},cdCookie)).status,400);
  assert.equal((await call('POST','/api/arrivals/'+ids[0],{arrival_time:'05:30'},supplierCookie)).status,403);
  assert.equal((await call('POST','/api/arrivals/'+ids[0],{arrival_time:''},cdCookie)).status,400);
  assert.equal((await call('POST','/api/arrivals/'+ids[0],{},cdCookie)).status,400);
  assert.equal((await call('GET','/api/arrivals?day='+day1,undefined,cdCookie)).data.bookings[0].arrival_time,null);
  for(const [id,time] of [[ids[0],'05:30'],[ids[1],'06:15'],[ids[2],'07:45']]){
    assert.equal((await call('POST','/api/arrivals/'+id,{arrival_time:time},cdCookie)).status,200);
  }
  const dayRows=(await call('GET','/api/arrivals?day='+day1,undefined,cdCookie)).data.bookings;
  assert.equal(dayRows.length,2);
  assert.deepEqual(dayRows.map(row=>row.arrival_time),['05:30','06:15']);
  const summary=await call('GET','/api/dashboard/delays?from='+day1+'&to='+day2,undefined,commercialCookie);
  assert.equal(summary.status,200);
  assert.equal(summary.data.suppliers.length,1);
  assert.equal(summary.data.suppliers[0].late_days,2);
  assert.equal(summary.data.suppliers[0].late_arrivals,3);
  assert.equal(summary.data.suppliers[0].total_delay_minutes,90);
  assert.equal(summary.data.suppliers[0].average_delay_minutes,30);
  const details=await call('GET','/api/dashboard/delays/'+supplier.id+'?from='+day1+'&to='+day2,undefined,cdCookie);
  assert.deepEqual(details.data.arrivals.map(row=>row.delay_minutes),[45,30,15]);
  assert.equal((await call('GET','/api/dashboard/delays?from='+day1+'&to='+day2,undefined,supplierCookie)).status,403);
  assert.equal((await call('POST','/api/arrivals/'+ids[0],{arrival_time:'05:45'},adminCookie)).status,200);
  const corrected=(await call('GET','/api/dashboard/delays?from='+day1+'&to='+day2,undefined,cdCookie)).data.suppliers[0];
  assert.equal(corrected.total_delay_minutes,105);
  const performance=await call('GET','/api/dashboard/arrival-performance?from='+day1+'&to='+day2,undefined,commercialCookie);
  assert.equal(performance.status,200);
  assert.deepEqual([performance.data.totals.scheduled,performance.data.totals.recorded,performance.data.totals.late,performance.data.totals.pending],[4,3,3,1]);
  assert.equal(performance.data.totals.late_minutes,105);
  assert.equal(performance.data.top_suppliers[0].late_days,2);
  assert.deepEqual(performance.data.days.map(row=>row.late),[2,1]);
  assert.equal((await call('GET','/api/dashboard/arrival-performance?from='+day1+'&to='+day2,undefined,supplierCookie)).status,403);
  assert.equal((await call('GET','/api/dashboard/arrival-performance?from='+day1+'&to='+day2+'&supplier_id='+supplier.id,undefined,commercialCookie)).status,403);
  assert.equal((await call('POST','/api/arrivals/'+ids[0],{arrival_time:'05:00'},adminCookie)).status,200);
  const punctual=(await call('GET','/api/dashboard/arrival-performance?from='+day1+'&to='+day2,undefined,cdCookie)).data;
  assert.deepEqual([punctual.totals.late,punctual.totals.on_time,punctual.totals.late_minutes],[2,1,60]);
  assert.equal((await call('POST','/api/arrivals/'+ids[0]+'/no-show',{},cdCookie)).status,409);
  assert.equal((await call('POST','/api/bookings/'+ids[0]+'/no-show',{},adminCookie)).status,409);
  assert.equal((await call('POST','/api/arrivals/'+pendingId+'/no-show',{},supplierCookie)).status,403);
  process.env.FLV_TEST_NOW=day2+'T08:00:00Z';
  assert.equal((await call('POST','/api/arrivals/'+pendingId+'/no-show',{},cdCookie)).status,400);
  process.env.FLV_TEST_NOW=day2+'T18:00:00Z';
  assert.equal((await call('POST','/api/arrivals/'+pendingId+'/no-show',{},cdCookie)).status,200);
  assert.equal((await call('POST','/api/arrivals/'+pendingId+'/no-show',{},adminCookie)).status,409);
  assert.equal((await call('POST','/api/arrivals/'+pendingId,{arrival_time:'08:15'},cdCookie)).status,404);
  const arrivals=(await call('GET','/api/arrivals?day='+day2,undefined,cdCookie)).data.bookings;
  assert.deepEqual(arrivals.map(row=>row.status),['active','no_show']);
  const withNoShow=(await call('GET','/api/dashboard/arrival-performance?from='+day1+'&to='+day3,undefined,commercialCookie)).data;
  assert.deepEqual([withNoShow.totals.scheduled,withNoShow.totals.scheduled_to_date,withNoShow.totals.no_show,withNoShow.totals.pending,withNoShow.totals.upcoming],[5,4,1,0,1]);
  assert.equal(withNoShow.top_no_show[0].no_show_percent,25);
  assert.equal(withNoShow.days[1].no_show,1);
  assert.equal(withNoShow.slots.find(row=>row.slot==='08:00').no_show,1);
  const lateSupplier=(await call('POST','/api/admin/suppliers',{name:'Fornecedor com maior tempo de atraso'},adminCookie)).data.supplier;
  const lateBooking=await call('POST','/api/bookings',{supplier_id:lateSupplier.id,day:day3,slot:'05:00',weight_kg:100,item_count:1,box_count:0,vehicle_type:'VUC',cargo_type:'Paletizada'},adminCookie);
  assert.equal(lateBooking.status,200);
  process.env.FLV_TEST_NOW=day3+'T18:00:00Z';
  assert.equal((await call('POST','/api/arrivals/'+lateBooking.data.booking.id,{arrival_time:'08:00'},cdCookie)).status,200);
  const ranked=(await call('GET','/api/dashboard/arrival-performance?from='+day1+'&to='+day3,undefined,adminCookie)).data.top_suppliers;
  assert.deepEqual(ranked.map(row=>row.supplier_id),[lateSupplier.id,supplier.id]);
  assert.deepEqual(ranked.map(row=>row.late_minutes),[180,60]);
  console.log('PASS: CD registra chegadas, perfis isolados e atrasos consolidados por data');
}finally{
  delete process.env.FLV_TEST_NOW;
  server.close();
}
