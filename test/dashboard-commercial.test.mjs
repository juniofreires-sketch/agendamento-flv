import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.FLV_TEST_MODE = '1';
const { server } = await import('../server.js');

async function call(method, url, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost:3100', cookie, origin: 'http://localhost:3100' };
    const res = {
      status: 200,
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(text) {
        try { resolve({ status: this.status, headers: this.headers, data: JSON.parse(text || '{}') }); }
        catch (error) { reject(error); }
      },
    };
    server.emit('request', req, res);
  });
}

try {
  const suppliers = (await call('GET', '/api/meta')).data.suppliers.slice(0, 2);
  const admin = await call('POST', '/api/bootstrap', { name: 'Admin Local', email: 'admin@local.test', password: '123456' });
  const adminCookie = admin.headers['set-cookie'].split(';')[0];
  await call('POST', '/api/register', { name: 'Comercial Local', email: 'comercial@local.test', password: '123456', supplier_id: suppliers[0].id });
  const pending = await call('GET', '/api/admin/pending', undefined, adminCookie);
  assert.equal((await call('POST', `/api/admin/users/${pending.data.users[0].id}/approve`, { role: 'commercial' }, adminCookie)).status, 200);
  const commercial = await call('POST', '/api/login', { email: 'comercial@local.test', password: '123456' });
  const commercialCookie = commercial.headers['set-cookie'].split(';')[0];
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 14);
  while (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  const day = date.toISOString().slice(0, 10);
  for (const [supplier, slot, weight] of [[suppliers[0], '06:00', 100], [suppliers[0], '08:00', 150], [suppliers[1], '05:00', 200]]) {
    const booking = await call('POST', '/api/bookings', {
      supplier_id: supplier.id, day, slot, weight_kg: weight, item_count: 2,
      box_count: 3, vehicle_type: 'VUC', cargo_type: 'Paletizada',
    }, adminCookie);
    assert.equal(booking.status, 200);
  }
  const details = await call('GET', `/api/dashboard/daily-suppliers?from=${day}&to=${day}`, undefined, commercialCookie);
  assert.equal(details.status, 200);
  assert.equal(details.data.length, 3);
  assert.deepEqual(details.data.map(row => row.supplier_name).sort(), [suppliers[0].name, suppliers[0].name, suppliers[1].name].sort());
  assert.deepEqual(details.data.map(row => row.slots), ['05:00', '06:00', '08:00']);
  assert.deepEqual(details.data.map(row => row.appointment_count), [1, 1, 1]);
  assert.equal(details.data.reduce((sum, row) => sum + row.weight_total, 0), 450);
  assert.equal((await call('GET', `/api/bookings?from=${day}&to=${day}`, undefined, commercialCookie)).status, 403);
  console.log('PASS: Comercial consulta fornecedores por data sem acesso à lista de agendamentos');
} finally {
  server.close();
}
