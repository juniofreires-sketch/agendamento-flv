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
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN (\'admin\',\'supplier\',\'commercial\',\'cd\')), status TEXT NOT NULL CHECK(status IN (\'active\',\'pending\')), supplier_id INTEGER REFERENCES suppliers(id), requested_supplier_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), user_id TEXT REFERENCES users(id) ON DELETE SET NULL, day TEXT NOT NULL, slot TEXT NOT NULL, order_number TEXT, invoice_number TEXT, weight_kg REAL NOT NULL, item_count INTEGER NOT NULL, box_count INTEGER NOT NULL, vehicle_type TEXT NOT NULL, cargo_type TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN (\'active\',\'cancelled\',\'no_show\')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, cancelled_at TEXT, no_show_at TEXT)',
  'CREATE INDEX IF NOT EXISTS bookings_day_slot ON bookings(day, slot, status)',
  'CREATE INDEX IF NOT EXISTS bookings_supplier ON bookings(supplier_id, day)'
].join(';\n') + ';');
if (!db.prepare('PRAGMA table_info(users)').all().some(col => col.name === 'requested_supplier_name'))
  db.exec('ALTER TABLE users ADD COLUMN requested_supplier_name TEXT');
if (!db.prepare('PRAGMA table_info(suppliers)').all().some(col => col.name === 'created_by'))
  db.exec('ALTER TABLE suppliers ADD COLUMN created_by TEXT');
if (!db.prepare('PRAGMA table_info(suppliers)').all().some(col => col.name === 'archived_at'))
  db.exec('ALTER TABLE suppliers ADD COLUMN archived_at TEXT');
const usersTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
if (!usersTableSql.includes("'cd'")) {
  db.exec(`PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE users_new (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','supplier','commercial','cd')), status TEXT NOT NULL CHECK(status IN ('active','pending')), supplier_id INTEGER REFERENCES suppliers(id), requested_supplier_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users_new SELECT id,name,email,password_hash,role,status,supplier_id,requested_supplier_name,created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys=ON;`);
}
const bookingUserColumn = db.prepare('PRAGMA table_info(bookings)').all().find(col => col.name === 'user_id');
const bookingColumns = db.prepare('PRAGMA table_info(bookings)').all();
const bookingsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get()?.sql || '';
if (bookingUserColumn?.notnull || !bookingsTableSql.includes("'no_show'") || !bookingColumns.some(col => col.name === 'no_show_at')) {
  const priorNoShowAt = bookingColumns.some(col => col.name === 'no_show_at') ? 'no_show_at' : 'NULL';
  db.exec(`PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE bookings_new (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), user_id TEXT REFERENCES users(id) ON DELETE SET NULL, day TEXT NOT NULL, slot TEXT NOT NULL, order_number TEXT, invoice_number TEXT, weight_kg REAL NOT NULL, item_count INTEGER NOT NULL, box_count INTEGER NOT NULL, vehicle_type TEXT NOT NULL, cargo_type TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','cancelled','no_show')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, cancelled_at TEXT, no_show_at TEXT);
    INSERT INTO bookings_new(id,supplier_id,user_id,day,slot,order_number,invoice_number,weight_kg,item_count,box_count,vehicle_type,cargo_type,status,created_at,cancelled_at,no_show_at)
      SELECT id,supplier_id,user_id,day,slot,order_number,invoice_number,weight_kg,item_count,box_count,vehicle_type,cargo_type,status,created_at,cancelled_at,${priorNoShowAt} FROM bookings;
    DROP TABLE bookings;
    ALTER TABLE bookings_new RENAME TO bookings;
    CREATE INDEX bookings_day_slot ON bookings(day, slot, status);
    CREATE INDEX bookings_supplier ON bookings(supplier_id, day);
    COMMIT;
    PRAGMA foreign_keys=ON;`);
}
db.exec(`CREATE TABLE IF NOT EXISTS booking_arrivals (
  booking_id INTEGER PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  arrival_time TEXT NOT NULL,
  recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
db.exec(`CREATE TABLE IF NOT EXISTS unscheduled_arrivals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  day TEXT NOT NULL,
  arrival_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','pending')),
  recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS unscheduled_arrivals_day_idx ON unscheduled_arrivals(day,supplier_id);`);
if (!db.prepare('PRAGMA table_info(unscheduled_arrivals)').all().some(column=>column.name==='status')) {
  db.exec("ALTER TABLE unscheduled_arrivals ADD COLUMN status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','pending'))");
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
VALUES ('global','05:00','09:00',30,9,81);`);
db.exec(`CREATE TABLE IF NOT EXISTS blocked_booking_days (
  day TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
const blockedBookingDay = day => Boolean(db.prepare('SELECT 1 FROM blocked_booking_days WHERE day=?').get(day));
const listBlockedBookingDays = () => db.prepare('SELECT day FROM blocked_booking_days ORDER BY day').all().map(row=>row.day);
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
const dailyLimitFor = settings => slotsFor(settings).length * Number(settings.vehicles_per_slot);
{
  let settings=getSchedulingSettings();
  if(settings.start_time==='05:00'&&settings.end_time==='10:00'&&Number(settings.interval_minutes)===30&&Number(settings.vehicles_per_slot)===5){
    db.prepare("UPDATE scheduling_settings SET start_time='05:00',end_time='09:00',interval_minutes=30,vehicles_per_slot=9 WHERE id='global'").run();
    settings=getSchedulingSettings();
  }
  db.prepare("UPDATE scheduling_settings SET daily_vehicle_limit=? WHERE id='global'").run(dailyLimitFor(settings));
}
const commercialMessage = settings => `Os agendamentos são feitos de segunda a sábado, das ${settings.start_time} às ${settings.end_time}. Para uma entrega fora dessa janela, entre em contato com o setor comercial.`;
const zone = 'America/Sao_Paulo';
const nowParts = () => {
  const d = process.env.FLV_TEST_MODE === '1' && process.env.FLV_TEST_NOW
    ? new Date(process.env.FLV_TEST_NOW) : new Date();
  const day = new Intl.DateTimeFormat('sv-SE', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit'}).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {timeZone:zone, hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(d);
  return {day, time};
};
const isValidDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day + 'T00:00:00Z')) && new Date(day + 'T00:00:00Z').toISOString().slice(0,10) === day;
const isSunday = day => new Date(day + 'T00:00:00Z').getUTCDay() === 0;
const allowedSlots = day => {
  const settings = getSchedulingSettings();
  const now = nowParts();
  if (!isValidDay(day) || isSunday(day) || day <= now.day || blockedBookingDay(day)) return [];
  return slotsFor(settings).filter(slot => day > now.day || slot >= now.time);
};
const availableSlotsFor = day => {
  const settings=getSchedulingSettings();
  const dailyCount=db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE day=? AND status='active'").get(day).n;
  if(dailyCount>=settings.daily_vehicle_limit)return [];
  const occupied=db.prepare("SELECT slot,COUNT(*) AS n FROM bookings WHERE day=? AND status='active' GROUP BY slot").all(day);
  const counts=Object.fromEntries(occupied.map(row=>[row.slot,row.n]));
  return allowedSlots(day).filter(slot=>(counts[slot]||0)<settings.vehicles_per_slot);
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
const delayMinutesSql = "(CAST(substr(a.arrival_time,1,2) AS INTEGER)*60+CAST(substr(a.arrival_time,4,2) AS INTEGER))-(CAST(substr(b.slot,1,2) AS INTEGER)*60+CAST(substr(b.slot,4,2) AS INTEGER))";
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
      const suppliers = db.prepare('SELECT id,name FROM suppliers WHERE archived_at IS NULL ORDER BY name').all().map(supplierRow);
      return json(res,200,{suppliers,vehicleTypes,cargoTypes,scheduling:getSchedulingSettings(),bootstrap:db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n === 0,googleEnabled:false,today:nowParts().day,current_time:nowParts().time});
    }
    if (req.method === 'GET' && p === '/api/availability') {
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','supplier'].includes(user.role))return fail(res,403,'Este perfil não pode consultar horários de agendamento.');
      const day=url.searchParams.get('day')||'';
      if(!isValidDay(day)||isSunday(day)||day<=nowParts().day)return fail(res,400,'Escolha uma data disponível a partir de amanhã. Domingos não recebem agendamentos.');
      if(blockedBookingDay(day))return json(res,200,{slots:[],blocked:true});
      return json(res,200,{slots:availableSlotsFor(day),blocked:false});
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
      if (!['admin','supplier'].includes(user.role)) return fail(res,403,'Este perfil não pode criar agendamentos.');
      if (user.role === 'supplier' && !user.supplier_id) return fail(res,403,'Seu usuário está sem fornecedor vinculado. Peça ao administrador para corrigir o cadastro antes de agendar.');
      const b = await readBody(req);
      const day = String(b.day||''), weight = Number(b.weight_kg), items = Number(b.item_count), boxes = b.box_count===''||b.box_count==null?0:Number(b.box_count);
      const settings = getSchedulingSettings();
      const supplierId = user.role === 'admin' ? Number(b.supplier_id) : user.supplier_id;
      if (!db.prepare('SELECT id FROM suppliers WHERE id=? AND archived_at IS NULL').get(supplierId)) return fail(res,400,'Selecione um fornecedor disponível.');
      if (!isValidDay(day) || isSunday(day) || day <= nowParts().day) return fail(res,400,'Os agendamentos estão disponíveis de segunda a sábado, somente a partir do dia seguinte. Para entregas fora da janela, entre em contato com o setor comercial.');
      if (blockedBookingDay(day)) return fail(res,409,'Os agendamentos para '+day.split('-').reverse().join('/')+' estão bloqueados. Escolha outra data.');
      if (!Number.isFinite(weight) || weight <= 0 || !Number.isInteger(items) || items < 0 || !Number.isInteger(boxes) || boxes < 0) return fail(res,400,'Informe peso positivo e quantidades inteiras maiores ou iguais a zero.');
      if (!vehicleTypes.includes(b.vehicle_type) || !cargoTypes.includes(b.cargo_type)) return fail(res,400,'Selecione o tipo de veículo e o tipo de carga.');
      const requestedSlot=String(b.slot||'').slice(0,5);
      if(!allowedSlots(day).includes(requestedSlot))return fail(res,400,'Selecione um horário válido para esta data.');
      const order = String(b.order_number||'').trim().slice(0,80), invoice = String(b.invoice_number||'').trim().slice(0,80);
      db.exec('BEGIN IMMEDIATE');
      try {
        if(blockedBookingDay(day)){db.exec('ROLLBACK');return fail(res,409,'Os agendamentos para '+day.split('-').reverse().join('/')+' estão bloqueados. Escolha outra data.');}
        const dailyCount = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE day=? AND status='active'").get(day).n;
        if (dailyCount >= settings.daily_vehicle_limit) { db.exec('ROLLBACK'); return fail(res,409,`O limite de ${settings.daily_vehicle_limit} veículos para esta data foi atingido. Escolha outro dia ou entre em contato com o setor comercial.`); }
        const occupied = db.prepare("SELECT slot,COUNT(*) AS n FROM bookings WHERE day=? AND status='active' GROUP BY slot").all(day);
        const counts = Object.fromEntries(occupied.map(x=>[x.slot,x.n]));
        if ((counts[requestedSlot]||0) >= settings.vehicles_per_slot) { db.exec('ROLLBACK'); return fail(res,409,'O horário selecionado acabou de ser preenchido. Atualize a disponibilidade e escolha outro horário.'); }
        const out = db.prepare("INSERT INTO bookings(supplier_id,user_id,day,slot,order_number,invoice_number,weight_kg,item_count,box_count,vehicle_type,cargo_type,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active')").run(supplierId,user.id,day,requestedSlot,order||null,invoice||null,weight,items,boxes,b.vehicle_type,b.cargo_type);
        db.exec('COMMIT');
        return sendBooking(res,Number(out.lastInsertRowid),user);
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    if (req.method === 'GET' && p === '/api/bookings') {
      const user = requireUser(req,res); if (!user) return;
      if (!['admin','supplier'].includes(user.role)) return fail(res,403,'Este perfil não tem acesso à lista de agendamentos.');
      if (user.role === 'supplier' && !user.supplier_id) return fail(res,403,'Seu usuário está sem fornecedor vinculado. Peça ao administrador para corrigir o cadastro.');
      const from = url.searchParams.get('from') || '0000-01-01', to = url.searchParams.get('to') || '9999-12-31';
      if (!isValidDay(from) || !isValidDay(to) || from > to) return fail(res,400,'Período inválido.');
      const supplier = user.role === 'admin' ? Number(url.searchParams.get('supplier_id')||0) : user.supplier_id;
      const sql = selectBookings + ' WHERE b.day BETWEEN ? AND ?' + (supplier ? ' AND b.supplier_id=?' : '') + ' ORDER BY b.day DESC,b.slot DESC,b.id DESC LIMIT 2000';
      const rows = db.prepare(sql).all(...(supplier?[from,to,supplier]:[from,to]));
      return json(res,200,{bookings:rows.map(bookingRow)});
    }
    if (req.method === 'GET' && p === '/api/dashboard/daily-suppliers') {
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','commercial','cd'].includes(user.role))return fail(res,403,'Sem permiss\u00e3o para acessar este painel.');
      const from=url.searchParams.get('from')||'0000-01-01',to=url.searchParams.get('to')||'9999-12-31';
      if(!isValidDay(from)||!isValidDay(to)||from>to)return fail(res,400,'Per\u00edodo inv\u00e1lido.');
      const selectedSupplier=user.role==='admin'?Number(url.searchParams.get('supplier_id')||0):0;
      const query=selectBookings+" WHERE b.day BETWEEN ? AND ? AND b.status='active'"+(selectedSupplier?' AND b.supplier_id=?':'')+' ORDER BY b.day,b.slot,s.name,b.id';
      const bookings=db.prepare(query).all(...(selectedSupplier?[from,to,selectedSupplier]:[from,to]));
      return json(res,200,bookings.map(row=>({day:row.day,supplier_id:row.supplier_id,supplier_name:row.supplier_name,appointment_count:1,slots:String(row.slot).slice(0,5),weight_total:Number(row.weight_kg),box_total:Number(row.box_count),item_total:Number(row.item_count)})));
    }
    if (req.method === 'GET' && p === '/api/dashboard') {
      const user = requireUser(req,res); if (!user) return;
      if (!['admin','commercial','cd'].includes(user.role)) return fail(res,403,'Sem permissão para acessar este painel.');
      const from=url.searchParams.get('from')||'0001-01-01', to=url.searchParams.get('to')||'9999-12-31';
      if (!isValidDay(from)||!isValidDay(to)||from>to) return fail(res,400,'Período inválido.');
      const rows=db.prepare(selectBookings+" WHERE b.day BETWEEN ? AND ? AND b.status='active' ORDER BY b.day").all(from,to).map(bookingRow);
      const weekdays=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
      const weekdayCounts=weekdays.slice(1).map((name,index)=>({name,count:rows.filter(b=>new Date(b.day+'T12:00:00Z').getUTCDay()===index+1).length}));
      const cargoCounts=cargoTypes.map(name=>({name,count:rows.filter(b=>b.cargo_type===name).length}));
      return json(res,200,{carros:rows.length,peso:rows.reduce((sum,b)=>sum+Number(b.weight_kg||0),0),items:rows.reduce((sum,b)=>sum+Number(b.item_count||0),0),boxes:rows.reduce((sum,b)=>sum+Number(b.box_count||0),0),weekday_counts:weekdayCounts,cargo_counts:cargoCounts});
    }
    if (req.method === 'GET' && p === '/api/dashboard/arrival-performance') {
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','commercial','cd'].includes(user.role))return fail(res,403,'Sem permissão para consultar o painel de chegadas.');
      const from=url.searchParams.get('from')||nowParts().day,to=url.searchParams.get('to')||nowParts().day;
      if(!isValidDay(from)||!isValidDay(to)||from>to)return fail(res,400,'Período inválido.');
      const supplierId=Number(url.searchParams.get('supplier_id')||0);
      if(supplierId&&user.role!=='admin')return fail(res,403,'Apenas administradores podem filtrar por fornecedor.');
      const rows=db.prepare(`SELECT b.day,b.slot,b.status,b.supplier_id,s.name AS supplier_name,a.arrival_time
        FROM bookings b JOIN suppliers s ON s.id=b.supplier_id
        LEFT JOIN booking_arrivals a ON a.booking_id=b.id
        WHERE b.status IN ('active','no_show') AND b.day BETWEEN ? AND ? AND (?=0 OR b.supplier_id=?)
        ORDER BY b.day,b.slot,b.id`).all(from,to,supplierId,supplierId);
      const totals={scheduled:0,scheduled_to_date:0,recorded:0,no_show:0,late:0,early:0,on_time:0,pending:0,upcoming:0,late_minutes:0,average_late_minutes:0};
      const days=new Map(),suppliers=new Map(),slots=new Map(),today=nowParts().day;
      for(const row of rows){
        const difference=row.arrival_time
          ? Number(row.arrival_time.slice(0,2))*60+Number(row.arrival_time.slice(3,5))-Number(row.slot.slice(0,2))*60-Number(row.slot.slice(3,5))
          : null;
        const late=Math.max(0,difference||0),recorded=difference!==null;
        totals.scheduled++;if(row.day<=today)totals.scheduled_to_date++;
        if(recorded)totals.recorded++;
        if(row.status==='no_show')totals.no_show++;
        if(difference>0)totals.late++;else if(difference<0)totals.early++;else if(recorded)totals.on_time++;
        if(!recorded&&row.status==='active')totals[row.day<=today?'pending':'upcoming']++;
        totals.late_minutes+=late;
        if(!days.has(row.day))days.set(row.day,{day:row.day,scheduled:0,recorded:0,no_show:0,late:0,on_time_or_early:0,pending:0,late_minutes:0});
        if(!suppliers.has(row.supplier_id))suppliers.set(row.supplier_id,{supplier_id:row.supplier_id,supplier_name:row.supplier_name,scheduled:0,scheduled_to_date:0,recorded:0,no_show:0,late:0,late_days:new Set(),late_minutes:0,average_late_minutes:0});
        if(!slots.has(row.slot))slots.set(row.slot,{slot:row.slot,scheduled:0,recorded:0,no_show:0,late:0,late_minutes:0});
        const day=days.get(row.day),supplier=suppliers.get(row.supplier_id),slot=slots.get(row.slot);
        for(const item of [day,supplier,slot]){item.scheduled++;if(recorded)item.recorded++;if(row.status==='no_show')item.no_show++;if(late){item.late++;item.late_minutes+=late}}
        if(row.day<=today)supplier.scheduled_to_date++;
        if(late)supplier.late_days.add(row.day);
        if(recorded&&difference<=0)day.on_time_or_early++;
        if(!recorded&&row.status==='active'&&row.day<=today)day.pending++;
      }
      totals.average_late_minutes=totals.late?Math.round(totals.late_minutes/totals.late*10)/10:0;
      const top_suppliers=Array.from(suppliers.values()).filter(item=>item.late).map(item=>({
        ...item,late_days:item.late_days.size,average_late_minutes:Math.round(item.late_minutes/item.late*10)/10
      })).sort((a,b)=>b.late_minutes-a.late_minutes||b.late-a.late||a.supplier_name.localeCompare(b.supplier_name,'pt-BR')).slice(0,10);
      const top_no_show=Array.from(suppliers.values()).filter(item=>item.no_show).map(item=>({
        supplier_id:item.supplier_id,supplier_name:item.supplier_name,no_show:item.no_show,
        scheduled_to_date:item.scheduled_to_date,
        no_show_percent:Math.round(item.no_show/item.scheduled_to_date*1000)/10
      })).sort((a,b)=>b.no_show-a.no_show||a.supplier_name.localeCompare(b.supplier_name,'pt-BR')).slice(0,10);
      return json(res,200,{totals,days:Array.from(days.values()).sort((a,b)=>a.day.localeCompare(b.day)),top_suppliers,top_no_show,
        slots:Array.from(slots.values()).sort((a,b)=>a.slot.localeCompare(b.slot))});
    }
    if (req.method === 'GET' && p === '/api/dashboard/unscheduled-arrivals') {
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','commercial','cd'].includes(user.role))return fail(res,403,'Sem permissão para consultar veículos fora da agenda.');
      const from=url.searchParams.get('from')||nowParts().day,to=url.searchParams.get('to')||nowParts().day;
      if(!isValidDay(from)||!isValidDay(to)||from>to)return fail(res,400,'Período inválido.');
      const supplierId=Number(url.searchParams.get('supplier_id')||0);
      if(supplierId&&user.role!=='admin')return fail(res,403,'Apenas administradores podem filtrar por fornecedor.');
      const throughDay=to<nowParts().day?to:nowParts().day;
      const scheduled=db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('active','no_show') AND day BETWEEN ? AND ? AND (?=0 OR supplier_id=?)").get(from,throughDay,supplierId,supplierId).n;
      const unscheduled=db.prepare("SELECT COUNT(*) AS n FROM unscheduled_arrivals WHERE status='recorded' AND day BETWEEN ? AND ? AND (?=0 OR supplier_id=?)").get(from,throughDay,supplierId,supplierId).n;
      const top=db.prepare(`SELECT u.supplier_id,s.name AS supplier_name,COUNT(*) AS unscheduled,
        (SELECT COUNT(*) FROM bookings b WHERE b.supplier_id=u.supplier_id AND b.status IN ('active','no_show') AND b.day BETWEEN ? AND ?) AS scheduled
        FROM unscheduled_arrivals u JOIN suppliers s ON s.id=u.supplier_id
        WHERE u.status='recorded' AND u.day BETWEEN ? AND ? AND (?=0 OR u.supplier_id=?)
        GROUP BY u.supplier_id,s.name ORDER BY unscheduled DESC,s.name LIMIT 10`).all(from,throughDay,from,throughDay,supplierId,supplierId);
      return json(res,200,{scheduled,unscheduled,unscheduled_percent:scheduled+unscheduled?Math.round(unscheduled*1000/(scheduled+unscheduled))/10:0,
        top_suppliers:top.map(row=>({...row,percent:Math.round(row.unscheduled*1000/(row.scheduled+row.unscheduled))/10}))});
    }
    if (req.method === 'GET' && p === '/api/arrivals') {
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','cd'].includes(user.role))return fail(res,403,'Apenas CD e administradores podem consultar chegadas.');
      const day=url.searchParams.get('day')||nowParts().day;
      if(!isValidDay(day))return fail(res,400,'Informe uma data válida.');
      const rows=db.prepare(`SELECT b.*,s.name AS supplier_name,a.arrival_time,a.recorded_at FROM bookings b JOIN suppliers s ON s.id=b.supplier_id LEFT JOIN booking_arrivals a ON a.booking_id=b.id WHERE b.day=? AND b.status IN ('active','no_show') ORDER BY b.slot,s.name,b.id`).all(day);
      return json(res,200,{bookings:rows.map(row=>({...bookingRow(row),booking_id:row.id,arrival_time:row.arrival_time||null,recorded_at:row.recorded_at||null}))});
    }
    if (p === '/api/arrivals/unscheduled') {
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','cd'].includes(user.role))return fail(res,403,'Apenas CD e administradores podem registrar veículos fora da agenda.');
      if(req.method==='GET'){
        const day=url.searchParams.get('day')||nowParts().day;
        if(!isValidDay(day))return fail(res,400,'Informe uma data válida.');
        const rows=db.prepare(`SELECT u.id,u.day,u.supplier_id,s.name AS supplier_name,u.arrival_time,u.status,u.created_at
          FROM unscheduled_arrivals u JOIN suppliers s ON s.id=u.supplier_id
          WHERE u.day=? ORDER BY u.arrival_time,s.name,u.id`).all(day);
        return json(res,200,{arrivals:rows});
      }
      if(req.method==='POST'){
        const body=await readBody(req),day=String(body.day||''),arrivalTime=String(body.arrival_time||''),supplierId=Number(body.supplier_id);
        if(!db.prepare('SELECT id FROM suppliers WHERE id=? AND archived_at IS NULL').get(supplierId))return fail(res,400,'Selecione um fornecedor disponível.');
        if(!isValidDay(day)||day>nowParts().day)return fail(res,400,'A data de chegada deve ser hoje ou uma data anterior.');
        if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(arrivalTime)||(day===nowParts().day&&arrivalTime>nowParts().time))return fail(res,400,'Informe um horário de chegada que não esteja no futuro.');
        const id=Number(db.prepare('INSERT INTO unscheduled_arrivals(supplier_id,day,arrival_time,recorded_by) VALUES (?,?,?,?)').run(supplierId,day,arrivalTime,user.id).lastInsertRowid);
        return json(res,201,{id});
      }
    }
    const deleteUnscheduled=/^\/api\/arrivals\/unscheduled\/(\d+)$/.exec(p);
    if(req.method==='DELETE'&&deleteUnscheduled){
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','cd'].includes(user.role))return fail(res,403,'Apenas CD e administradores podem excluir veículos fora da agenda.');
      const id=Number(deleteUnscheduled[1]);
      const result=db.prepare('DELETE FROM unscheduled_arrivals WHERE id=?').run(id);
      if(!result.changes)return fail(res,404,'Registro fora da agenda não encontrado.');
      return json(res,200,{ok:true});
    }
    const arrivalNoShow=/^\/api\/arrivals\/(\d+)\/no-show$/.exec(p);
    const undoNoShow=/^\/api\/arrivals\/(\d+)\/undo-no-show$/.exec(p);
    if(req.method==='POST'&&undoNoShow){
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','cd'].includes(user.role))return fail(res,403,'Apenas CD e administradores podem estornar No show.');
      const id=Number(undoNoShow[1]);
      const booking=db.prepare('SELECT status FROM bookings WHERE id=?').get(id);
      if(!booking)return fail(res,404,'Agendamento não encontrado.');
      if(booking.status!=='no_show')return fail(res,409,'Somente registros No show podem ser estornados.');
      if(db.prepare('SELECT 1 FROM booking_arrivals WHERE booking_id=?').get(id))return fail(res,409,'Este fornecedor já possui horário de chegada registrado.');
      db.prepare("UPDATE bookings SET status='active',no_show_at=NULL WHERE id=? AND status='no_show'").run(id);
      return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&arrivalNoShow){
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','cd'].includes(user.role))return fail(res,403,'Apenas CD e administradores podem marcar No show.');
      const id=Number(arrivalNoShow[1]);
      const booking=db.prepare('SELECT day,slot,status FROM bookings WHERE id=?').get(id);
      if(!booking)return fail(res,404,'Agendamento não encontrado.');
      if(booking.status!=='active')return fail(res,409,'Somente agendamentos confirmados podem ser marcados No show.');
      const now=nowParts();
      if(booking.day>now.day||(booking.day===now.day&&booking.slot>now.time))return fail(res,400,'No show só pode ser registrado após o horário agendado.');
      if(db.prepare('SELECT 1 FROM booking_arrivals WHERE booking_id=?').get(id))return fail(res,409,'Este fornecedor já possui horário de chegada registrado.');
      db.prepare("UPDATE bookings SET status='no_show',no_show_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      return json(res,200,{ok:true});
    }
    const arrivalMatch=/^\/api\/arrivals\/(\d+)$/.exec(p);
    if (req.method === 'POST' && arrivalMatch) {
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','cd'].includes(user.role))return fail(res,403,'Apenas CD e administradores podem registrar chegadas.');
      const body=await readBody(req),arrivalTime=String(body.arrival_time||'');
      if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(arrivalTime))return fail(res,400,'Informe um horário de chegada válido.');
      const booking=db.prepare("SELECT day,status FROM bookings WHERE id=?").get(Number(arrivalMatch[1]));
      if(!booking||booking.status!=='active')return fail(res,404,'Agendamento confirmado não encontrado.');
      const now=nowParts();
      if(booking.day>now.day||(booking.day===now.day&&arrivalTime>now.time))return fail(res,400,'O horário de chegada não pode estar no futuro.');
      db.prepare(`INSERT INTO booking_arrivals(booking_id,arrival_time,recorded_by) VALUES (?,?,?)
        ON CONFLICT(booking_id) DO UPDATE SET arrival_time=excluded.arrival_time,recorded_by=excluded.recorded_by,updated_at=CURRENT_TIMESTAMP`)
        .run(Number(arrivalMatch[1]),arrivalTime,user.id);
      return json(res,200,{ok:true});
    }
    if (req.method === 'GET' && p === '/api/dashboard/delays') {
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','commercial','cd'].includes(user.role))return fail(res,403,'Sem permissão para consultar atrasos.');
      const from=url.searchParams.get('from')||nowParts().day,to=url.searchParams.get('to')||nowParts().day;
      if(!isValidDay(from)||!isValidDay(to)||from>to)return fail(res,400,'Período inválido.');
      const rows=db.prepare(`SELECT b.supplier_id,s.name AS supplier_name,COUNT(DISTINCT b.day) AS late_days,
        COUNT(*) AS late_arrivals,SUM(${delayMinutesSql}) AS total_delay_minutes,
        ROUND(AVG(${delayMinutesSql}),1) AS average_delay_minutes
        FROM bookings b JOIN booking_arrivals a ON a.booking_id=b.id
        JOIN suppliers s ON s.id=b.supplier_id
        WHERE b.status='active' AND b.day BETWEEN ? AND ? AND a.arrival_time>b.slot
        GROUP BY b.supplier_id,s.name ORDER BY late_days DESC,total_delay_minutes DESC,s.name`).all(from,to);
      return json(res,200,{suppliers:rows});
    }
    const delayDetails=/^\/api\/dashboard\/delays\/(\d+)$/.exec(p);
    if (req.method === 'GET' && delayDetails) {
      const user=requireUser(req,res);if(!user)return;
      if(!['admin','commercial','cd'].includes(user.role))return fail(res,403,'Sem permissão para consultar atrasos.');
      const from=url.searchParams.get('from')||nowParts().day,to=url.searchParams.get('to')||nowParts().day;
      if(!isValidDay(from)||!isValidDay(to)||from>to)return fail(res,400,'Período inválido.');
      const rows=db.prepare(`SELECT b.day,b.slot,a.arrival_time,${delayMinutesSql} AS delay_minutes
        FROM bookings b JOIN booking_arrivals a ON a.booking_id=b.id
        WHERE b.supplier_id=? AND b.status='active' AND b.day BETWEEN ? AND ? AND a.arrival_time>b.slot
        ORDER BY b.day DESC,b.slot,b.id`).all(Number(delayDetails[1]),from,to);
      return json(res,200,{arrivals:rows});
    }
    const match = /^\/api\/bookings\/(\d+)(?:\/(cancel|no-show))?$/.exec(p);
    if (match && req.method === 'GET' && !match[2]) {
      const user = requireUser(req,res); if (!user) return;
      return sendBooking(res,Number(match[1]),user);
    }
    if (match && req.method === 'POST' && match[2] === 'cancel') {
      const user = requireUser(req,res); if (!user) return;
      const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(match[1]));
      if (!b || (user.role !== 'admin' && b.supplier_id !== user.supplier_id)) return fail(res,404,'Agendamento não encontrado.');
      if (b.status !== 'active') return fail(res,409,'Somente agendamentos confirmados podem ser cancelados.');
      db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP WHERE id=?").run(b.id);
      return sendBooking(res,b.id,user);
    }
    if (match && req.method === 'POST' && match[2] === 'no-show') {
      const user = requireUser(req,res,true); if (!user) return;
      const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(match[1]));
      if (!b) return fail(res,404,'Agendamento não encontrado.');
      if (b.status !== 'active') return fail(res,409,'Somente agendamentos confirmados podem ser marcados como No show.');
      const now=nowParts();
      if (b.day > now.day || (b.day===now.day && b.slot>now.time)) return fail(res,400,'No show só pode ser registrado após o horário agendado.');
      if (db.prepare('SELECT 1 FROM booking_arrivals WHERE booking_id=?').get(b.id)) return fail(res,409,'Este fornecedor já possui horário de chegada registrado.');
      db.prepare("UPDATE bookings SET status='no_show',no_show_at=CURRENT_TIMESTAMP WHERE id=?").run(b.id);
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
    if (p === '/api/admin/blocked-days') {
      if (!requireUser(req,res,true)) return;
      if (req.method === 'GET') return json(res,200,{days:listBlockedBookingDays()});
      if (req.method === 'POST') {
        const {day,blocked}=await readBody(req);
        if(!isValidDay(day)||typeof blocked!=='boolean')return fail(res,400,'Informe uma data válida.');
        if(blocked&&(day<=nowParts().day||isSunday(day)))return fail(res,400,'Escolha uma data futura de segunda a sábado.');
        if(blocked)db.prepare('INSERT OR IGNORE INTO blocked_booking_days(day) VALUES (?)').run(day);
        else db.prepare('DELETE FROM blocked_booking_days WHERE day=?').run(day);
        return json(res,200,{days:listBlockedBookingDays()});
      }
    }
    if (req.method === 'POST' && p === '/api/admin/settings') {
      if (!requireUser(req,res,true)) return;
      const b=await readBody(req), start=String(b.start_time||''), end=String(b.end_time||''), interval=Number(b.interval_minutes), perSlot=Number(b.vehicles_per_slot);
      const timePattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
      const startMinutes=timePattern.test(start)?Number(start.slice(0,2))*60+Number(start.slice(3)):NaN;
      const endMinutes=timePattern.test(end)?Number(end.slice(0,2))*60+Number(end.slice(3)):NaN;
      if(!Number.isFinite(startMinutes)||!Number.isFinite(endMinutes)||endMinutes<=startMinutes||![30,60].includes(interval)||((endMinutes-startMinutes)%interval)!==0||(startMinutes%30!==0||endMinutes%30!==0)||(interval===60&&(startMinutes%60!==0||endMinutes%60!==0))||!Number.isInteger(perSlot)||perSlot<1||perSlot>10000)
        return fail(res,400,'Confira os horários, o intervalo (30 ou 60 minutos) e os limites de veículos.');
      const perDay=(Math.floor((endMinutes-startMinutes)/interval)+1)*perSlot;
      db.prepare("UPDATE scheduling_settings SET start_time=?,end_time=?,interval_minutes=?,vehicles_per_slot=?,daily_vehicle_limit=? WHERE id='global'").run(start,end,interval,perSlot,perDay);
      return json(res,200,{scheduling:getSchedulingSettings()});
    }
    const updateRole=/^\/api\/admin\/users\/([a-f0-9]+)\/role$/.exec(p);
    if (req.method === 'POST' && updateRole) {
      const admin=requireUser(req,res,true); if (!admin) return;
      if (updateRole[1]===admin.id) return fail(res,400,'Não é possível alterar o próprio perfil.');
      const b=await readBody(req), role=String(b.role||''), selected=Number(b.supplier_id||0);
      if(!['admin','supplier','commercial','cd'].includes(role)) return fail(res,400,'Selecione Administrador, Fornecedor, Comercial ou CD.');
      const target=db.prepare('SELECT id,status FROM users WHERE id=?').get(updateRole[1]);
      if(!target) return fail(res,404,'Usuário não encontrado.');
      if(target.status!=='active') return fail(res,400,'Altere o perfil pela aprovação pendente deste usuário.');
      const name=String(b.supplier_name||'').trim().replace(/\s+/g,' ');
      if(role==='supplier'&&name&&(selected||name.length<3||name.length>160))return fail(res,400,'Escolha um fornecedor existente ou informe uma nova razão social com 3 a 160 caracteres.');
      if(role==='supplier'&&!name&&!db.prepare('SELECT id FROM suppliers WHERE id=? AND archived_at IS NULL').get(selected)) return fail(res,400,'Selecione um fornecedor disponível para este usuário.');
      db.exec('BEGIN IMMEDIATE');
      try {
        let supplierId=selected;
        if(role==='supplier'&&name)supplierId=Number(db.prepare('INSERT INTO suppliers(name,created_by) VALUES (?,?)').run(name,admin.id).lastInsertRowid);
        db.prepare('UPDATE users SET role=?,supplier_id=?,requested_supplier_name=NULL WHERE id=?').run(role,role==='supplier'?supplierId:null,updateRole[1]);
        db.exec('COMMIT');
      } catch (error) {db.exec('ROLLBACK');if(String(error.message).includes('UNIQUE'))return fail(res,409,'Este fornecedor já está cadastrado.');throw error}
      return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[a-f0-9]+\/approve$/.test(p)) {
      if (!requireUser(req,res,true)) return;
      const b=await readBody(req), role=String(b.role||'supplier');
      if (!['admin','supplier','commercial','cd'].includes(role)) return fail(res,400,'Escolha Administrador, Fornecedor, Comercial ou CD.');
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
      const admin=requireUser(req,res,true); if (!admin) return;
      const b=await readBody(req), name=String(b.name||'').trim().replace(/\s+/g,' ');
      if (name.length<3 || name.length>160) return fail(res,400,'Informe a razão social com 3 a 160 caracteres.');
      try {
        const out=db.prepare('INSERT INTO suppliers(name,created_by) VALUES (?,?)').run(name,admin.id);
        return json(res,201,{supplier:{id:Number(out.lastInsertRowid),name}});
      } catch { return fail(res,409,'Este fornecedor já está cadastrado.'); }
    }
    if (req.method === 'GET' && p === '/api/admin/manual-suppliers') {
      if (!requireUser(req,res,true)) return;
      return json(res,200,{suppliers:db.prepare('SELECT id,name FROM suppliers WHERE created_by IS NOT NULL AND archived_at IS NULL ORDER BY name').all()});
    }
    const archiveSupplier=/^\/api\/admin\/manual-suppliers\/(\d+)\/archive$/.exec(p);
    if (req.method === 'POST' && archiveSupplier) {
      if (!requireUser(req,res,true)) return;
      const id=Number(archiveSupplier[1]);
      const supplier=db.prepare('SELECT id FROM suppliers WHERE id=? AND created_by IS NOT NULL AND archived_at IS NULL').get(id);
      if(!supplier)return fail(res,404,'Fornecedor criado manualmente não encontrado.');
      if(db.prepare('SELECT id FROM users WHERE supplier_id=? LIMIT 1').get(id))return fail(res,409,'Altere o vínculo dos usuários deste fornecedor antes de excluí-lo.');
      db.prepare("UPDATE suppliers SET archived_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      return json(res,200,{ok:true});
    }
    return fail(res,404,'Página não encontrada.');
  } catch (e) {
    console.error(e);
    return fail(res,500,'Não foi possível concluir a operação. Tente novamente.');
  }
});
if (process.env.FLV_TEST_MODE !== '1') server.listen(port,'127.0.0.1',()=>console.log('Portal FLV: http://localhost:'+port));
export { server };
