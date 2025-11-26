// server/index.js
//
// Node/Express backend for the College Timetable Management System.
// - Weekly fixed classes are stored in server/data/masterSchedule.json
// - Date specific events are stored in server/data/events.json
// - All mutating operations require a valid admin JWT token.
// - Socket.io is used to push live updates to all connected clients.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');

// ---- basic config ----
const DATA_DIR = path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'masterSchedule.json');
const JWT_SECRET = process.env.JWT_SECRET || 'changeme-super-secret';

// simple in-memory admin accounts for demo – in production replace with DB / real auth
const ADMIN_ACCOUNTS = [
  { userId: 'admin1', password: 'pass1' },
  { userId: 'admin2', password: 'pass2' }
];

// make sure data dir/files exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(EVENTS_FILE)) {
  fs.writeFileSync(EVENTS_FILE, '[]', 'utf8');
}
if (!fs.existsSync(SCHEDULE_FILE)) {
  fs.writeFileSync(SCHEDULE_FILE, '[]', 'utf8');
}

// helpers to read / write JSON safely
function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read JSON from', filePath, err.message);
    return [];
  }
}
function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readEvents() { return readJson(EVENTS_FILE); }
function writeEvents(events) { writeJson(EVENTS_FILE, events); }
function readSchedule() { return readJson(SCHEDULE_FILE); }
function writeSchedule(schedule) { writeJson(SCHEDULE_FILE, schedule); }

// ---- express + socket.io wiring ----
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS']
  }
});

app.use(cors());
app.use(bodyParser.json());

// ---- auth middleware & login ----
function authMiddleware(req, res, next) {
  // Only protect mutating routes; reads stay public.
  // We'll attach this middleware only on specific routes below,
  // but keep it reusable.
  const header = req.headers['authorization'] || '';
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ message: 'Missing token' });
  }
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.isAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    req.user = payload;
    return next();
  } catch (err) {
    console.error('JWT error', err.message);
    return res.status(401).json({ message: 'Invalid token' });
  }
}

// POST /api/login → { token, userId }
app.post('/api/login', (req, res) => {
  const { userId, password } = req.body || {};
  if (!userId || !password) {
    return res.status(400).json({ message: 'userId and password required' });
  }
  const found = ADMIN_ACCOUNTS.find(
    (a) => a.userId === userId && a.password === password
  );
  if (!found) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const token = jwt.sign({ userId: found.userId, isAdmin: true }, JWT_SECRET, {
    expiresIn: '12h'
  });
  return res.json({ token, userId: found.userId });
});

// simple health check
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// ---- weekly fixed schedule APIs ----

// GET /api/schedule → full weekly schedule array
app.get('/api/schedule', (req, res) => {
  const schedule = readSchedule();
  return res.json(schedule);
});

// POST /api/schedule/slot
// Body: { day, room, startTime, endTime, className }
// Behaviour:
// - remove any existing entries for same day+room whose time-range overlaps
// - if className is a non-empty string -> insert new entry
// - if className is empty / whitespace -> treat as DELETE (do not insert)
// Returns: { success, schedule }
app.post('/api/schedule/slot', authMiddleware, (req, res) => {
  const { day, room, startTime, endTime, className } = req.body || {};
  if (!day || !room || !startTime || !endTime) {
    return res.status(400).json({ error: 'missing fields' });
  }

  const schedule = readSchedule();

  function toMinutes(str) {
    const [h, m] = String(str).split(':').map((x) => parseInt(x, 10) || 0);
    return h * 60 + m;
  }

  const sMin = toMinutes(startTime);
  const eMin = toMinutes(endTime);

  const filtered = schedule.filter((item) => {
    if (item.day !== day || item.room !== room) return true;
    const itS = toMinutes(item.startTime);
    const itE = toMinutes(item.endTime);
    // keep only if NOT overlapping
    if (!(eMin <= itS || sMin >= itE)) {
      return false;
    }
    return true;
  });

  const trimmedName = (className || '').trim();
  if (trimmedName) {
    filtered.push({ day, room, startTime, endTime, className: trimmedName });
  }

  try {
    writeSchedule(filtered);
    const payload = readSchedule();
    io.emit('schedule:update', payload);
    return res.json({ success: true, schedule: payload });
  } catch (err) {
    console.error('write schedule error', err);
    return res.status(500).json({ error: 'write failed' });
  }
});

// ---- date-specific events APIs ----

// GET /api/events?date=YYYY-MM-DD (optional date)
// - If date is provided, only return that date's events
// - If not, return all events
app.get('/api/events', (req, res) => {
  const date = (req.query.date || '').trim();
  const events = readEvents();
  if (!date) {
    return res.json(events);
  }
  const filtered = events.filter((e) => e.date === date);
  return res.json(filtered);
});

// POST /api/events
// Body: { action, ... }
//  action = "create": { date, room, startTime, endTime, eventName }
//  action = "update": { id, date, room, startTime, endTime, eventName }
//  action = "delete": { id }
app.post('/api/events', authMiddleware, (req, res) => {
  const { action } = req.body || {};
  let events = readEvents();

  if (!action) {
    return res.status(400).json({ message: 'action is required' });
  }

  if (action === 'create') {
    const { date, room, startTime, endTime, eventName } = req.body || {};
    if (!date || !room || !startTime || !endTime || !eventName) {
      return res.status(400).json({ message: 'Missing fields' });
    }
    const id =
      Date.now().toString(36) + '-' + Math.floor(Math.random() * 10000);
    const ev = {
      id,
      date,
      room,
      startTime,
      endTime,
      eventName,
      createdBy: req.user && req.user.userId
    };
    events.push(ev);
  } else if (action === 'update') {
    const { id, date, room, startTime, endTime, eventName } = req.body || {};
    if (!id) return res.status(400).json({ message: 'id is required' });
    events = events.map((e) => {
      if (e.id !== id) return e;
      return {
        ...e,
        date: date || e.date,
        room: room || e.room,
        startTime: startTime || e.startTime,
        endTime: endTime || e.endTime,
        eventName: eventName || e.eventName
      };
    });
  } else if (action === 'delete') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ message: 'id is required' });
    events = events.filter((e) => e.id !== id);
  } else {
    return res.status(400).json({ message: 'Unknown action' });
  }

  try {
    writeEvents(events);
    const latest = readEvents();
    io.emit('events:update', latest);
    return res.json({ success: true, events: latest });
  } catch (err) {
    console.error('write events error', err);
    return res.status(500).json({ message: 'write failed' });
  }
});

// ---- static assets (for local testing if desired) ----
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- socket.io real-time wiring ----
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // Immediately send current schedule + events
  try {
    const schedule = readSchedule();
    socket.emit('schedule:update', schedule);
    const events = readEvents();
    socket.emit('events:update', events);
  } catch (err) {
    console.error('error sending initial data to socket', err);
  }

  // Optional request-based refresh
  socket.on('request:schedule', () => {
    try {
      const schedule = readSchedule();
      socket.emit('schedule:update', schedule);
    } catch (err) {
      console.error('request:schedule failed', err);
    }
  });

  socket.on('request:events', () => {
    try {
      const events = readEvents();
      socket.emit('events:update', events);
    } catch (err) {
      console.error('request:events failed', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('socket disconnect', socket.id);
  });
});

// ---- start server ----
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
