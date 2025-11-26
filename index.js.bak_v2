const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');

const DATA_PATH = path.join(__dirname,'data','events.json');
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const ADMIN_ACCOUNTS = [
  { userId: 'admin1', password: 'pass1' },
  { userId: 'admin2', password: 'pass2' }
];

function readEvents(){
  try{
    const s = fs.readFileSync(DATA_PATH,'utf8');
    return JSON.parse(s||'[]');
  }catch(e){
    return [];
  }
}
function writeEvents(arr){
  fs.writeFileSync(DATA_PATH, JSON.stringify(arr, null, 2), 'utf8');
}

if(!fs.existsSync(path.join(__dirname,'data'))){
  fs.mkdirSync(path.join(__dirname,'data'), { recursive: true });
}
if(!fs.existsSync(DATA_PATH)){
  writeEvents([]);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json());

// simple auth middleware
function authMiddleware(req,res,next){
  const h = req.headers.authorization || '';
  const m = h.split(' ');
  if(m.length!==2 || m[0] !== 'Bearer') return res.status(401).json({message:'Missing token'});
  const token = m[1];
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  }catch(err){
    return res.status(401).json({message:'Invalid token'});
  }
}

// login
app.post('/api/login', (req,res)=>{
  const { userId, password } = req.body || {};
  if(!userId || !password) return res.status(400).json({message:'userId and password required'});
  const found = ADMIN_ACCOUNTS.find(a=>a.userId===userId && a.password===password);
  if(!found) return res.status(401).json({message:'Invalid credentials'});
  const token = jwt.sign({ userId: found.userId, isAdmin: true }, JWT_SECRET, { expiresIn: '12h' });
  return res.json({ token, userId: found.userId });
});

// get events
app.get('/api/events', (req,res)=>{
  const events = readEvents();
  res.json(events);
});

// create event (protected)
app.post('/api/events', authMiddleware, (req,res)=>{
  const { date, room, startTime, endTime, eventName } = req.body || {};
  if(!date || !room || !startTime || !endTime || !eventName) return res.status(400).json({message:'Missing fields'});
  const events = readEvents();
  const id = Date.now().toString(36) + '-' + Math.floor(Math.random()*10000);
  const ev = { id, date, room, startTime, endTime, eventName, createdBy: req.user.userId };
  events.push(ev);
  writeEvents(events);
  io.emit('events:update', events);
  res.status(201).json(ev);
});

// delete event (protected)
app.delete('/api/events/:id', authMiddleware, (req,res)=>{
  const id = req.params.id;
  let events = readEvents();
  const before = events.length;
  events = events.filter(e=>e.id!==id);
  if(events.length===before) return res.status(404).json({message:'Not found'});
  writeEvents(events);
  io.emit('events:update', events);
  res.json({ success: true });
});

// simple health
app.get('/api/ping', (req,res)=>res.json({ok:true}));

io.on('connection', (socket)=>{
  // send current events on connect
  const ev = readEvents();
  socket.emit('events:update', ev);
  console.log('socket connected', socket.id);
  socket.on('disconnect', ()=> console.log('socket disconnect', socket.id));
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, ()=> console.log('Server listening on', PORT));
