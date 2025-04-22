const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(cors());

// Initialize SQLite database
const db = new sqlite3.Database('./database.db', err => {
  if (err) console.error('DB error', err);
});

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    subscriptionExpiry TEXT,
    hasPaid INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    idNumber TEXT UNIQUE NOT NULL,
    address TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS dependants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memberId INTEGER NOT NULL,
    name TEXT NOT NULL,
    dob TEXT,
    FOREIGN KEY(memberId) REFERENCES members(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memberId INTEGER NOT NULL,
    planType TEXT,
    coverLevel REAL,
    premium REAL,
    startDate TEXT,
    status TEXT,
    FOREIGN KEY(memberId) REFERENCES members(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policyId INTEGER NOT NULL,
    amount REAL,
    paidAt TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(policyId) REFERENCES policies(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policyId INTEGER NOT NULL,
    deathCertPath TEXT,
    affidavitPath TEXT,
    status TEXT DEFAULT 'Submitted',
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(policyId) REFERENCES policies(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE
  )`);
});

// Utility to add 30-day trial
function addTrial(userId) {
  const expiry = new Date(Date.now() + 30*24*60*60*1000).toISOString();
  db.run('UPDATE users SET subscriptionExpiry = ? WHERE id = ?', [expiry, userId]);
}

// Auth
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (name,email,password) VALUES (?,?,?)', [name,email,hash], function(err) {
      if (err) return res.status(err.code==='SQLITE_CONSTRAINT'?400:500).json({ error: err.code==='SQLITE_CONSTRAINT'?'Email in use':'DB error' });
      addTrial(this.lastID);
      res.json({ message: 'Registered, trial for 30 days.', trialEnds: new Date(Date.now()+30*24*60*60*1000).toISOString() });
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'All fields required' });
  db.get('SELECT * FROM users WHERE email=?', [email], async (err, user) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid credentials' });
    const now = new Date();
    const expiry = user.subscriptionExpiry ? new Date(user.subscriptionExpiry) : null;
    if (!expiry || expiry < now)
      return res.status(403).json({ error: 'Trial expired. Pay R300 to continue.', trialExpired: true });
    res.json({ message: 'Login successful' });
  });
});

// Subscription payment
app.post('/api/subscription/pay', (req, res) => {
  const { userId, reference } = req.body;
  if (!userId || !reference) return res.status(400).json({ error: 'Missing userId or reference' });
  const newExpiry = new Date(Date.now()+30*24*60*60*1000).toISOString();
  db.run('UPDATE users SET hasPaid=1, subscriptionExpiry=? WHERE id=?', [newExpiry,userId], err => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ message: 'Payment recorded, subscription extended.', newExpiry });
  });
});

// Members CRUD
app.get('/api/members', (req,res)=> db.all('SELECT * FROM members',[],(e,rows)=> e?res.status(500).json({error:'DB'}):res.json(rows)));
app.post('/api/members',(req,res)=>{
  const {name,idNumber,address}=req.body;
  db.run('INSERT INTO members (name,idNumber,address) VALUES (?,?,?)',[name,idNumber,address],function(err){
    if(err) return res.status(500).json({ error:'DB' });
    res.json({ id:this.lastID });
  });
});
app.put('/api/members/:id',(req,res)=>{
  const {name,idNumber,address}=req.body;
  db.run('UPDATE members SET name=?,idNumber=?,address=? WHERE id=?',[name,idNumber,address,req.params.id], err => err?res.status(500).json({error:'DB'}):res.sendStatus(200));
});
app.delete('/api/members/:id',(req,res)=> db.run('DELETE FROM members WHERE id=?',[req.params.id],err=>err?res.status(500).json({error:'DB'}):res.sendStatus(200)));

// Dependants CRUD
app.get('/api/dependants',(req,res)=> db.all('SELECT * FROM dependants',[],(e,r)=> e?res.status(500).json({error:'DB'}):res.json(r)));
app.post('/api/dependants',(req,res)=>{
  const{memberId,name,dob}=req.body;
  db.run('INSERT INTO dependants (memberId,name,dob) VALUES (?,?,?)',[memberId,name,dob],function(err){
    if(err) return res.status(500).json({error:'DB'});
    res.json({id:this.lastID});
  });
});
app.put('/api/dependants/:id',(req,res)=>{
  const{memberId,name,dob}=req.body;
  db.run('UPDATE dependants SET memberId=?,name=?,dob=? WHERE id=?',[memberId,name,dob,req.params.id],err=>err?res.status(500).json({error:'DB'}):res.sendStatus(200));
});
app.delete('/api/dependants/:id',(req,res)=> db.run('DELETE FROM dependants WHERE id=?',[req.params.id],err=>err?res.status(500).json({error:'DB'}):res.sendStatus(200)));

// Policies CRUD
app.get('/api/policies',(req,res)=> db.all('SELECT * FROM policies',[],(e,r)=>e?res.status(500).json({error:'DB'}):res.json(r)));
app.post('/api/policies',(req,res)=>{
  const{memberId,planType,coverLevel,premium,startDate,status}=req.body;
  db.run('INSERT INTO policies (memberId,planType,coverLevel,premium,startDate,status) VALUES (?,?,?,?,?,?)',
    [memberId,planType,coverLevel,premium,startDate,status], function(err){
      if(err) return res.status(500).json({error:'DB'});
      res.json({id:this.lastID});
    });
});
app.put('/api/policies/:id',(req,res)=>{
  const{planType,coverLevel,premium,startDate,status}=req.body;
  db.run('UPDATE policies SET planType=?,coverLevel=?,premium=?,startDate=?,status=? WHERE id=?',
    [planType,coverLevel,premium,startDate,status,req.params.id], err=>err?res.status(500).json({error:'DB'}):res.sendStatus(200));
});
app.delete('/api/policies/:id',(req,res)=> db.run('DELETE FROM policies WHERE id=?',[req.params.id],err=>err?res.status(500).json({error:'DB'}):res.sendStatus(200)));

// Payments endpoint
app.post('/api/payments',(req,res)=>{
  const{policyId,amount}=req.body;
  db.run('INSERT INTO payments (policyId,amount) VALUES (?,?)',[policyId,amount],function(err){
    if(err) return res.status(500).json({error:'DB'});
    res.json({ id:this.lastID });
  });
});

// Notifications
app.post('/api/notifications/reminders',(req,res)=>{
  // stub: send SMS/email reminders
  res.json({ message: 'Monthly reminders sent.' });
});

// Documentation (PDF stub)
app.get('/api/documentation/:id',(req,res)=>{
  const file = path.join(__dirname,'policy_sample.pdf');
  res.download(file, `policy_${req.params.id}.pdf`);
});

// Claims (file upload)
const upload = multer({ dest: 'uploads/' });
app.post('/api/claims', upload.fields([{ name: 'deathCert' },{ name: 'affidavit' }]), (req,res)=>{
  const { policyId } = req.body;
  const dc = req.files['deathCert'][0].path;
  const aff = req.files['affidavit'][0].path;
  db.run('INSERT INTO claims (policyId,deathCertPath,affidavitPath) VALUES (?,?,?)',[policyId,dc,aff],function(err){
    if(err) return res.status(500).json({error:'DB'});
    res.json({ id:this.lastID });
  });
});

// Agents CRUD
app.get('/api/agents',(req,res)=> db.all('SELECT * FROM agents',[],(e,r)=>e?res.status(500).json({error:'DB'}):res.json(r)));
app.post('/api/agents',(req,res)=>{
  const{ name,email }=req.body;
  db.run('INSERT INTO agents (name,email) VALUES (?,?)',[name,email],function(err){
    if(err) return res.status(500).json({error:'DB'});
    res.json({id:this.lastID});
  });
});
app.delete('/api/agents/:id',(req,res)=> db.run('DELETE FROM agents WHERE id=?',[req.params.id],err=>err?res.status(500).json({error:'DB'}):res.sendStatus(200)));

// Retail sync
app.post('/api/retail/sync',(req,res)=>{
  // stub: integrate with payment platforms
  res.json({ message: 'Retail payments synced.' });
});

// Lapse & Arrears
app.post('/api/lapse/run',(req,res)=>{
  // stub: find policies with missed payments
  res.json({ summary: 'Lapse check complete.' });
});

// Reports
app.get('/api/reports/:type',(req,res)=>{
  // stub: return dummy analytics
  res.json({ report: req.params.type, data: [] });
});

app.listen(port, () => console.log(`Server running on port ${port}`));
