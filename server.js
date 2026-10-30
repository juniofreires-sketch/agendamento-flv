import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.FLV_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(process.env.FLV_TEST_MODE === '1' ? ':memory:' : path.join(dataDir, 'flv.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec([
  'CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)',
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN (\'admin\',\'supplier\',\'commercial\')), status TEXT NOT NULL CHECK(status IN (\'active\',\'pending\')), supplier_id INTEGER REFERENCES suppliers(id), requested_supplier_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), user_id TEXT REFERENCES users(id) ON DELETE SET NULL, day TEXT NOT NULL, slot TEXT NOT NULL, order_number TEXT, invoice_number TEXT, weight_kg REAL NOT NULL, item_count INTEGER NOT NULL, box_count INTEGER NOT NULL, vehicle_type TEXT NOT NULL, cargo_type TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN (\'active\',\'cancelled\')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, cancelled_at TEXT)',
  'CREATE INDEX IF NOT EXISTS bookings_day_slot ON bookings(day, slot, status)',
  'CREATE INDEX IF NOT EXISTS bookings_supplier ON bookings(supplier_id, day)'
].join(';\n') + ';');
if (!db.prepare('PRAGMA table_info(users)').all().some(col => col.name === 'requested_supplier_name'))
  db.exec('ALTER TABLE users ADD COLUMN requested_supplier_name TEXT');
const usersTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
if (!usersTableSql.includes("'commercial'")) {
  db.exec(`PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE users_new (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','supplier','commercial')), status TEXT NOT NULL CHECK(status IN ('active','pending')), supplier_id INTEGER REFERENCES suppliers(id), requested_supplier_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users_new SELECT id,name,email,password_hash,role,status,supplier_id,requested_supplier_name,created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys=ON;`);
}
const bookingUserColumn = db.prepare('PRAGMA table_info(bookings)').all().find(col => col.name === 'user_id');
if (bookingUserColumn?.notnull) {
  db.exec(`PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE bookings_new (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), user_id TEXT REFERENCES users(id) ON DELETE SET NULL, day TEXT NOT NULL, slot TEXT NOT NULL, order_number TEXT, invoice_number TEXT, weight_kg REAL NOT NULL, item_count INTEGER NOT NULL, box_count INTEGER NOT NULL, vehicle_type TEXT NOT NULL, cargo_type TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','cancelled')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, cancelled_at TEXT);
    INSERT INTO bookings_new SELECT * FROM bookings;
    DROP TABLE bookings;
    ALTER TABLE bookings_new RENAME TO bookings;
    CREATE INDEX bookings_day_slot ON bookings(day, slot, status);
    CREATE INDEX bookings_supplier ON bookings(supplier_id, day);
    COMMIT;
    PRAGMA foreign_keys=ON;`);
}

const cleanSupplierName = name => String(name).trim().replace(/^[0-9][0-9./-]*\s+/, '').replace(/\s+/g, ' ');
const seed = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'suppliers.json'), 'utf8')).map(cleanSupplierName))];
const insertSupplier = db.prepare('INSERT OR IGNORE INTO suppliers(name) VALUES (?)');
for (const name of seed) insertSupplier.run(name);
db.exec('BEGIN IMMEDIATE');
try {
  const renameSupplier = db.prepare('UPDATE suppliers SET name=? WHERE id=?');
  const reassignUsers = db.prepare('UPDATE users SET supplier_id=? WHERE supplier_id=?');
  const reassignBookings = db.prepare('UPDATE bookings SET supplier_id=? WHERE supplier_id=?');
  const deleteSupplier = db.prepare('DELETE FROM suppliers WHERE id=?');
  for (const supplier of db.prepare('SELECT id,name FROM suppliers').all()) {
    const cleanName = cleanSupplierName(supplier.name);
    if (cleanName === supplier.name) continue;
    const canonical = db.prepare('SELECT id FROM suppliers WHERE name=? COLLATE NOCASE AND id<>?').get(cleanName,supplier.id);
    if (canonical) {
      reassignUsers.run(canonical.id,supplier.id);
      reassignBookings.run(canonical.id,supplier.id);
      deleteSupplier.run(supplier.id);
    } else renameSupplier.run(cleanName,supplier.id);
  }
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }
db.exec(`CREATE TABLE IF NOT EXISTS scheduling_settings (
  id TEXT PRIMARY KEY CHECK(id='global'), start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK(interval_minutes IN (30,60)),
  vehicles_per_slot INTEGER NOT NULL CHECK(vehicles_per_slot>0),
  daily_vehicle_limit INTEGER NOT NULL CHECK(daily_vehicle_limit>0)
);
INSERT OR IGNORE INTO scheduling_settings(id,start_time,end_time,interval_minutes,vehicles_per_slot,daily_vehicle_limit)
VALUES ('global','05:00','10:00',30,5,55);`);
const vehicleTypes = ['3/4','BITREM','CARRETA 24','CARRETA 26','CARRETA 28','CARRETA 30','FIORINO','TOCO','TRUCK','VUC'];
const cargoTypes = ['Batida / Paletizada','Carga batida','Paletizada','Pallet sobreposto'];
const getSchedulingSettings = () => db.prepare("SELECT start_time,end_time,interval_minutes,vehicles_per_slot,daily_vehicle_limit FROM scheduling_settings WHERE id='global'").get();
const slotsFor = settings => {
  const [startHour,startMinute] = settings.start_time.split(':').map(Number);
  const [endHour,endMinute] = settings.end_time.split(':').map(Number);
  const start = startHour * 60 + startMinute, end = endHour * 60 + endMinute;
  return Array.from({length:Math.floor((end-start)/settings.interval_minutes)+1},(_,i)=>{
    const minute=start+i*settings.interval_minutes;
    return String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
  });
};
const commercialMessage = settings => `Os agendamentos são feitos de segunda a sábado, das ${settings.start_time} às ${settings.end_time}. Para uma entrega fora dessa janela, entre em contato com o setor comercial.`;
const zone = 'America/Sao_Paulo';
const nowParts = () => {
  const d = new Date();
  const day = new Intl.DateTimeFormat('sv-SE', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit'}).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {timeZone:zone, hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(d);
  return {day, time};
};
const isValidDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day + 'T00:00:00Z')) && new Date(day + 'T00:00:00Z').toISOString().slice(0,10) === day;
const isSunday = day => new Date(day + 'T00:00:00Z').getUTCDay() === 0;
const allowedSlots = day => {
  const settings = getSchedulingSettings();
  const now = nowParts();
  if (!isValidDay(day) || isSunday(day) || day < now.day) return [];
  return slotsFor(settings).filter(slot => day > now.day || slot >= now.time);
};
const json = (res, status, body, headers={}) => {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers});
  res.end(JSON.stringify(body));
};
const fail = (res, status, message) => json(res,status,{error:message});
const readBody = async req => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32768) throw new Error('O formulário é muito grande.');
  }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Dados inválidos.'); }
};
const hashPassword = password => {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password,salt,64).toString('hex');
};
const verifyPassword = (password, stored) => {
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password,salt,64);
  return timingSafeEqual(actual,Buffer.from(hash,'hex'));
};
const hashToken = token => createHash('sha256').update(token).digest('hex');
const currentUser = req => {
  const token = /(?:^|; )flv_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return null;
  return db.prepare('SELECT u.id,u.name,u.email,u.role,u.status,u.supplier_id,s.name AS supplier_name FROM sessions x JOIN users u ON u.id=x.user_id LEFT JOIN suppliers s ON s.id=u.supplier_id WHERE x.token_hash=? AND x.expires_at > CURRENT_TIMESTAMP').get(hashToken(token)) || null;
};
const requireUser = (req,res,admin=false) => {
  const user = currentUser(req);
  if (!user || user.status !== 'active') { fail(res,401,'Faça login para continuar.'); return null; }
  if (admin && user.role !== 'admin') { fail(res,403,'Acesso restrito ao administrador.'); return null; }
  return user;
};
const createSession = (res,user) => {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7*86400000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(hashToken(token),user.id,expires);
  json(res,200,{user}, {'set-cookie':'flv_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800'});
};
const supplierRow = row => ({id:row.id,name:row.name});
const bookingRow = row => ({
  id:row.id, supplier_id:row.supplier_id, supplier_name:row.supplier_name, day:row.day,
  slot:row.slot, order_number:row.order_number, invoice_number:row.invoice_number,
  weight_kg:row.weight_kg, item_count:row.item_count, box_count:row.box_count,
  vehicle_type:row.vehicle_type, cargo_type:row.cargo_type, status:row.status,
  created_at:row.created_at, cancelled_at:row.cancelled_at
});
const selectBookings = 'SELECT b.*, s.name AS supplier_name FROM bookings b JOIN suppliers s ON s.id=b.supplier_id';
const sendBooking = (res,id,user) => {
  const b = db.prepare(selectBookings+' WHERE b.id=?').get(id);
  if (!b || (user.role !== 'admin' && b.supplier_id !== user.supplier_id)) return fail(res,404,'Agendamento não encontrado.');
  return json(res,200,{booking:bookingRow(b)});
};
const sendFile = (res,filename,type) => {
  const file = path.join(root,'public',filename);
  try {
    res.writeHead(200,{'content-type':type,'cache-control':'no-cache'});
    fs.createReadStream(file).pipe(res);
  } catch { fail(res,404,'Página não encontrada.'); }
};
const port = Number(process.env.PORT || 3100);
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res,'index.html','text/html; charset=utf-8');
    if (req.method === 'GET' && p === '/styles.css') return sendFile(res,'styles.css','text/css; charset=utf-8');
    if (req.method === 'GET' && p === '/app.js') return sendFile(res,'app.js','text/javascript; charset=utf-8');
    if (req.method === 'GET' && p === '/logo-dia-a-dia.png') return sendFile(res,'logo-dia-a-dia.png','image/png');
    if (req.method === 'GET' && p === '/login-warehouse.png') return sendFile(res,'login-warehouse.png','image/png');
    if (p.startsWith('/api/') && !['GET','HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return fail(res,403,'Origem não autorizada.');
    }
    if (req.method === 'GET' && p === '/api/meta') {
      const suppliers = db.prepare('SELECT id,name FROM suppliers ORDER BY name').all().map(supplierRow);
      return json(res,200,{suppliers,vehicleTypes,cargoTypes,scheduling:getSchedulingSettings(),bootstrap:db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n === 0,googleEnabled:false,today:nowParts().day,current_time:nowParts().time});
    }
    if (req.method === 'POST' && p === '/api/bootstrap') {
      if (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n) return fail(res,403,'Administrador já configurado.');
      const b = await readBody(req);
      const name = String(b.name||'').trim(), email = String(b.email||'').trim().toLowerCase(), password = String(b.password||'');
      if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6) return fail(res,400,'Informe nome, email válido e senha de pelo menos 6 caracteres.');
      const id = randomBytes(16).toString('hex');
      db.prepare("INSERT INTO users(id,name,email,password_hash,role,status) VALUES (?,?,?,?, 'admin','active')").run(id,name,email,hashPassword(password));
      return createSession(res,{id,name,email,role:'admin',status:'active',supplier_id:null,supplier_name:null});
    }
    if (req.method === 'POST' && p === '/api/register') {
      const b = await readBody(req);
      const name = String(b.name||'').trim(), email = String(b.email||'').trim().toLowerCase(), password = String(b.password||'');
      if (email === 'junior.matheus64@gmail.com') return fail(res,400,'Este email está reservado para a administração.');
      const supplier = b.supplier_id ? db.prepare('SELECT id FROM suppliers WHERE id=?').get(Number(b.supplier_id)) : null;
      const requestedSupplier = String(b.supplier_name||'').trim().replace(/\s+/g,' ');
      if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6 || (!supplier && (requestedSupplier.length < 3 || requestedSupplier.length > 160))) return fail(res,400,'Confira nome, email, senha (mínimo 6 caracteres) e fornecedor.');
      try {
        db.prepare("INSERT INTO users(id,name,email,password_hash,role,status,supplier_id,requested_supplier_name) VALUES (?,?,?,?, 'supplier','pending',?,?)").run(randomBytes(16).toString('hex'),name,email,hashPassword(password),supplier?.id||null,supplier?null:requestedSupplier);
      } catch { return fail(res,409,'Este email já está cadastrado.'); }
      return json(res,201,{message:'Cadastro recebido! Nossa equipe avaliará seus dados. Após a aprovação do administrador, você poderá acessar o portal.'});
    }
    if (req.method === 'POST' && p === '/api/login') {
      const b = await readBody(req);
      const row = db.prepare('SELECT u.*,s.name AS supplier_name FROM users u LEFT JOIN suppliers s ON s.id=u.supplier_id WHERE u.email=?').get(String(b.email||'').trim().toLowerCase());
      if (!row || !verifyPassword(String(b.password||''),row.password_hash)) return fail(res,401,'Email ou senha incorretos.');
      if (row.status !== 'active') return fail(res,403,'Seu cadastro está aguardando aprovação do administrador.');
      return createSession(res,{id:row.id,name:row.name,email:row.email,role:row.role,status:row.status,supplier_id:row.supplier_id,supplier_name:row.supplier_name});
    }
    if (req.method === 'POST' && p === '/api/logout') {
      const token = /(?:^|; )flv_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
      return json(res,200,{ok:true},{'set-cookie':'flv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    }
    if (req.method === 'GET' && p === '/api/me') return json(res,200,{user:currentUser(req)});
    if (req.method === 'POST' && p === '/api/bookings') {
      const user = requireUser(req,res); if (!user) return;
      const b = await readBody(req);
      const day = String(b.day||''), weight = Number(b.weight_kg), items = Number(b.item_count), boxes = Number(b.box_count);
      const settings = getSchedulingSettings();
      const supplierId = user.role === 'admin' ? Number(b.supplier_id) : user.supplier_id;
      if (!db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId)) return fail(res,400,'Selecione um fornecedor válido.');
      if (!isValidDay(day) || isSunday(day) || day < nowParts().day) return fail(res,400,commercialMessage(settings));
      if (!Number.isFinite(weight) || weight <= 0 || !Number.isInteger(items) || items < 0 || !Number.isInteger(boxes) || boxes < 0) return fail(res,400,'Informe peso positivo e quantidades inteiras maiores ou iguais a zero.');
      if (!vehicleTypes.includes(b.vehicle_type) || !cargoTypes.includes(b.cargo_type)) return fail(res,400,'Selecione o tipo de veículo e o tipo de carga.');
      const order = String(b.order_number||'').trim().slice(0,80), invoice = String(b.invoice_number||'').trim().slice(0,80);
      db.exec('BEGIN IMMEDIATE');
      try {
        const eligible = allowedSlots(day);
        if (!eligible.length) { db.exec('ROLLBACK'); return fail(res,400,commercialMessage(settings)); }
        const dailyCount = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE day=? AND status='active'").get(day).n;
        if (dailyCount >= settings.daily_vehicle_limit) { db.exec('ROLLBACK'); return fail(res,409,`O limite de ${settings.daily_vehicle_limit} veículos para esta data foi atingido. Escolha outro dia ou entre em contato com o setor comercial.`); }
        const occupied = db.prepare("SELECT slot,COUNT(*) AS n FROM bookings WHERE day=? AND status='active' GROUP BY slot").all(day);
        const counts = Object.fromEntries(occupied.map(x=>[x.slot,x.n]));
        const slot = eligible.find(x=>(counts[x]||0)<settings.vehicles_per_slot);
        if (!slot) { db.exec('ROLLBACK'); return fail(res,409,'Todos os horários deste dia estão completos. Escolha outra data ou entre em contato com o setor comercial.'); }
        const out = db.prepare("INSERT INTO bookings(supplier_id,user_id,day,slot,order_number,invoice_number,weight_kg,item_count,box_count,vehicle_type,cargo_type,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active')").run(supplierId,user.id,day,slot,order||null,invoice||null,weight,items,boxes,b.vehicle_type,b.cargo_type);
        db.exec('COMMIT');
        return sendBooking(res,Number(out.lastInsertRowid),user);
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    if (req.method === 'GET' && p === '/api/bookings') {
      const user = requireUser(req,res); if (!user) return;
      if (user.role === 'commercial') return fail(res,403,'O perfil comercial não tem acesso à lista de agendamentos.');
      const from = url.searchParams.get('from') || '0000-01-01', to = url.searchParams.get('to') || '9999-12-31';
      if (!isValidDay(from) || !isValidDay(to) || from > to) return fail(res,400,'Período inválido.');
      const supplier = user.role === 'admin' ? Number(url.searchParams.get('supplier_id')||0) : user.supplier_id;
      const sql = selectBookings + ' WHERE b.day BETWEEN ? AND ?' + (supplier ? ' AND b.supplier_id=?' : '') + ' ORDER BY b.day DESC,b.slot DESC,b.id DESC LIMIT 2000';
      const rows = db.prepare(sql).all(...(supplier?[from,to,supplier]:[from,to]));
      return json(res,200,{bookings:rows.map(bookingRow)});
    }
    if (req.method === 'GET' && p === '/api/dashboard') {
      const user = requireUser(req,res); if (!user) return;
      if (!['admin','commercial'].includes(user.role)) return fail(res,403,'Sem permissão para acessar este painel.');
      const from=url.searchParams.get('from')||'0001-01-01', to=url.searchParams.get('to')||'9999-12-31';
      if (!isValidDay(from)||!isValidDay(to)||from>to) return fail(res,400,'Período inválido.');
      const rows=db.prepare(selectBookings+" WHERE b.day BETWEEN ? AND ? AND b.status='active' ORDER BY b.day").all(from,to).map(bookingRow);
      const weekdays=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
      const weekdayCounts=weekdays.slice(1).map((name,index)=>({name,count:rows.filter(b=>new Date(b.day+'T12:00:00Z').getUTCDay()===index+1).length}));
      const cargoCounts=cargoTypes.map(name=>({name,count:rows.filter(b=>b.cargo_type===name).length}));
      return json(res,200,{carros:rows.length,peso:rows.reduce((sum,b)=>sum+Number(b.weight_kg||0),0),items:rows.reduce((sum,b)=>sum+Number(b.item_count||0),0),boxes:rows.reduce((sum,b)=>sum+Number(b.box_count||0),0),weekday_counts:weekdayCounts,cargo_counts:cargoCounts});
    }
    const match = /^\/api\/bookings\/(\d+)(?:\/(cancel))?$/.exec(p);
    if (match && req.method === 'GET' && !match[2]) {
      const user = requireUser(req,res); if (!user) return;
      return sendBooking(res,Number(match[1]),user);
    }
    if (match && req.method === 'POST' && match[2] === 'cancel') {
      const user = requireUser(req,res); if (!user) return;
      const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(match[1]));
      if (!b || (user.role !== 'admin' && b.supplier_id !== user.supplier_id)) return fail(res,404,'Agendamento não encontrado.');
      if (b.status === 'cancelled') return fail(res,409,'Este agendamento já está cancelado.');
      db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP WHERE id=?").run(b.id);
      return sendBooking(res,b.id,user);
    }
    if (req.method === 'GET' && p === '/api/admin/pending') {
      if (!requireUser(req,res,true)) return;
      return json(res,200,{users:db.prepare("SELECT u.id,u.name,u.email,u.created_at,u.requested_supplier_name,coalesce(s.name,u.requested_supplier_name) AS supplier_name FROM users u LEFT JOIN suppliers s ON s.id=u.supplier_id WHERE u.status='pending' AND u.role='supplier' ORDER BY u.created_at").all()});
    }
    if (req.method === 'GET' && p === '/api/admin/users') {
      if (!requireUser(req,res,true)) return;
      return json(res,200,{users:db.prepare("SELECT u.id,u.name,u.email,u.role,u.status,u.created_at,u.requested_supplier_name,coalesce(s.name,u.requested_supplier_name) AS supplier_name FROM users u LEFT JOIN suppliers s ON s.id=u.supplier_id ORDER BY u.created_at DESC").all()});
    }
    if (req.method === 'POST' && p === '/api/admin/settings') {
      if (!requireUser(req,res,true)) return;
      const b=await readBody(req), start=String(b.start_time||''), end=String(b.end_time||''), interval=Number(b.interval_minutes), perSlot=Number(b.vehicles_per_slot), perDay=Number(b.daily_vehicle_limit);
      const timePattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
      const startMinutes=timePattern.test(start)?Number(start.slice(0,2))*60+Number(start.slice(3)):NaN;
      const endMinutes=timePattern.test(end)?Number(end.slice(0,2))*60+Number(end.slice(3)):NaN;
      if(!Number.isFinite(startMinutes)||!Number.isFinite(endMinutes)||endMinutes<=startMinutes||![30,60].includes(interval)||((endMinutes-startMinutes)%interval)!==0||(startMinutes%30!==0||endMinutes%30!==0)||(interval===60&&(startMinutes%60!==0||endMinutes%60!==0))||![perSlot,perDay].every(n=>Number.isInteger(n)&&n>0&&n<=10000))
        return fail(res,400,'Confira os horários, o intervalo (30 ou 60 minutos) e os limites de veículos.');
      db.prepare("UPDATE scheduling_settings SET start_time=?,end_time=?,interval_minutes=?,vehicles_per_slot=?,daily_vehicle_limit=? WHERE id='global'").run(start,end,interval,perSlot,perDay);
      return json(res,200,{scheduling:getSchedulingSettings()});
    }
    const updateRole=/^\/api\/admin\/users\/([a-f0-9]+)\/role$/.exec(p);
    if (req.method === 'POST' && updateRole) {
      const admin=requireUser(req,res,true); if (!admin) return;
      if (updateRole[1]===admin.id) return fail(res,400,'Não é possível alterar o próprio perfil.');
      const b=await readBody(req), role=String(b.role||''), selected=Number(b.supplier_id||0);
      if(!['admin','supplier','commercial'].includes(role)) return fail(res,400,'Selecione Administrador, Fornecedor ou Comercial.');
      if(role==='supplier'&&!db.prepare('SELECT id FROM suppliers WHERE id=?').get(selected)) return fail(res,400,'Selecione um fornecedor para este usuário.');
      const target=db.prepare('SELECT id,status FROM users WHERE id=?').get(updateRole[1]);
      if(!target) return fail(res,404,'Usuário não encontrado.');
      if(target.status!=='active') return fail(res,400,'Altere o perfil pela aprovação pendente deste usuário.');
      db.prepare('UPDATE users SET role=?,supplier_id=?,requested_supplier_name=NULL WHERE id=?').run(role,role==='supplier'?selected:null,updateRole[1]);
      return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[a-f0-9]+\/approve$/.test(p)) {
      if (!requireUser(req,res,true)) return;
      const b=await readBody(req), role=String(b.role||'supplier');
      if (!['admin','supplier','commercial'].includes(role)) return fail(res,400,'Escolha Administrador, Fornecedor ou Comercial.');
      const id=p.split('/')[4];
      const pending=db.prepare("SELECT * FROM users WHERE id=? AND status='pending' AND role='supplier'").get(id);
      if (!pending) return fail(res,404,'Cadastro pendente não encontrado.');
      db.exec('BEGIN IMMEDIATE');
      try {
        let supplierId=role==='supplier'?pending.supplier_id:null;
        if (role==='supplier'&&!supplierId) {
          db.prepare('INSERT OR IGNORE INTO suppliers(name) VALUES (?)').run(pending.requested_supplier_name);
          supplierId=db.prepare('SELECT id FROM suppliers WHERE name=? COLLATE NOCASE').get(pending.requested_supplier_name).id;
        }
        db.prepare("UPDATE users SET status='active',role=?,supplier_id=?,requested_supplier_name=? WHERE id=?").run(role,supplierId,role==='supplier'?pending.requested_supplier_name:null,id);
        db.exec('COMMIT');
      } catch (e) {db.exec('ROLLBACK');throw e}
      return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[a-f0-9]+\/delete$/.test(p)) {
      if (!requireUser(req,res,true)) return;
      const id=p.split('/')[4];
      const target=db.prepare("SELECT id FROM users WHERE id=? AND role='supplier'").get(id);
      if (!target) return fail(res,404,'Usuário fornecedor não encontrado.');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
        db.prepare('DELETE FROM users WHERE id=?').run(id);
        db.exec('COMMIT');
      } catch (e) {db.exec('ROLLBACK');throw e}
      return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && p === '/api/admin/suppliers') {
      if (!requireUser(req,res,true)) return;
      const b=await readBody(req), name=String(b.name||'').trim().replace(/\s+/g,' ');
      if (name.length<3 || name.length>160) return fail(res,400,'Informe a razão social com 3 a 160 caracteres.');
      try {
        const out=db.prepare('INSERT INTO suppliers(name) VALUES (?)').run(name);
        return json(res,201,{supplier:{id:Number(out.lastInsertRowid),name}});
      } catch { return fail(res,409,'Este fornecedor já está cadastrado.'); }
    }
    return fail(res,404,'Página não encontrada.');
  } catch (e) {
    console.error(e);
    return fail(res,500,'Não foi possível concluir a operação. Tente novamente.');
  }
});
if (process.env.FLV_TEST_MODE !== '1') server.listen(port,'127.0.0.1',()=>console.log('Portal FLV: http://localhost:'+port));
export { server };
