const express = require('express');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/image', express.static(__dirname + '/image'));

const SECRET_KEY = process.env.SECRET_KEY || 'asdfghjqwerty';

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  ssl: { rejectUnauthorized: false },
});

// ------------------ Signup API ------------------
app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  try {
    const hashedPassword = await bcrypt.hash(password, 8);
    await pool.query(
      'INSERT INTO users (username, password, balance, is_admin) VALUES ($1, $2, $3, $4)',
      [username, hashedPassword, 1000, false]
    );
    res.json({ message: 'User registered successfully' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------ Login API ------------------
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, username: user.username, is_admin: user.is_admin },
      SECRET_KEY,
      { expiresIn: '1d' }
    );

    res.json({ token, balance: user.balance, is_admin: user.is_admin });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------ Admin Middleware ------------------
function adminOnly(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing token' });

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, SECRET_KEY);
    if (!payload.is_admin) return res.status(403).json({ error: 'Access denied' });
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ------------------ Admin APIs ------------------
app.post('/admin/set-balance', adminOnly, async (req, res) => {
  try {
    const { username, balance } = req.body;
    if (!username || isNaN(balance)) return res.status(400).json({ error: 'Invalid username or balance' });

    const result = await pool.query('UPDATE users SET balance = $1 WHERE username = $2', [balance, username]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ message: 'Balance updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});



app.get('/admin/get-users', adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, balance FROM users');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/admin/update-user/:id', adminOnly, async (req, res) => {
  const { id } = req.params;
  const { username, password, balance } = req.body;

  try {
    let sql, params;
    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      sql = 'UPDATE users SET username = $1, password = $2, balance = $3 WHERE id = $4';
      params = [username, hashedPassword, balance, id];
    } else {
      sql = 'UPDATE users SET username = $1, balance = $2 WHERE id = $3';
      params = [username, balance, id];
    }

    const result = await pool.query(sql, params);
    if (result.rowCount > 0) res.json({ success: true, message: 'User updated successfully' });
    else res.status(404).json({ success: false, message: 'User not found' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.delete('/admin/delete-user/:id', adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------ Serve Admin HTML ------------------
app.get('/admin/admin-users.html', adminOnly, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'admin-users.html'));
});

app.get('/admin/set-balance.html', adminOnly, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'set-balance.html'));
});

// Protect signup.html
app.get('/signup.html', adminOnly, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'signup.html'));
});

// ------------------ Socket.io Multiplayer Game ------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let currentBets = [];
let countdownTimer = null;
let countdownSeconds = 10;
let countdownActive = false;
let multiplier = 1.0;
let multiplierInterval = null;
let gameInProgress = false;
let crashMultiplier = 0;

// --- Game logs storage ---
let gameLogs = [];
function addLog(msg){
  const logMsg = `[${new Date().toLocaleTimeString()}] ${msg}`;
  gameLogs.unshift(logMsg);
  if(gameLogs.length>50) gameLogs.pop();
  console.log(logMsg);
}

function startCountdown() {
  if (countdownActive) return;
  countdownActive = true;
  countdownSeconds = 10;
  crashMultiplier = +(Math.random() * 8.5 + 1.5).toFixed(2);

  io.emit('countdownStarted', countdownSeconds);
  io.emit('crashPoint', crashMultiplier);

  addLog(`Countdown started, crash point at ${crashMultiplier}x`);

  countdownTimer = setInterval(() => {
    countdownSeconds--;
    io.emit('countdownTick', countdownSeconds);

    if (countdownSeconds <= 0) {
      clearInterval(countdownTimer);
      countdownActive = false;
      io.emit('countdownEnded');
      addLog('Countdown ended, game in progress');

      if (currentBets.length > 0) startMultiplier();
      else currentBets = [];
    }
  }, 1000);
}

function startMultiplier() {
  if (gameInProgress) return;
  multiplier = 1.0;
  gameInProgress = true;
  io.emit('multiplierUpdate', multiplier);
  addLog('Multiplier started');

  multiplierInterval = setInterval(() => {
    multiplier += 0.01;
    multiplier = Math.round(multiplier * 100) / 100;
    io.emit('multiplierUpdate', multiplier);

    const totalPlayers = currentBets.length;
    const cashedOutCount = currentBets.filter(b => b.cashedOut).length;

    if (totalPlayers > 0 && cashedOutCount / totalPlayers >= 0.5) crashGame();
    else if (multiplier >= crashMultiplier) crashGame();
  }, 100);
}

function crashGame() {
  clearInterval(multiplierInterval);
  multiplierInterval = null;
  gameInProgress = false;
  io.emit('gameCrashed', multiplier);
  addLog(`Game crashed at ${multiplier.toFixed(2)}x`);
  calculatePayouts();
  currentBets = [];
}

async function calculatePayouts() {
  const winners = currentBets.filter(b => b.cashedOut);
  const losers = currentBets.filter(b => !b.cashedOut);

  const totalLoserBets = losers.reduce((sum, b) => sum + b.betAmount, 0);
  const adminCommission = totalLoserBets * 0.10;
  const distributableAmount = totalLoserBets - adminCommission;

  const totalProfits = winners.reduce((sum, b) => sum + (b.betAmount * (b.cashoutMultiplier - 1)), 0);
  let payoutRatio = distributableAmount < totalProfits ? distributableAmount / totalProfits : 1;

  for (const bet of winners) {
    const profit = bet.betAmount * (bet.cashoutMultiplier - 1) * payoutRatio;
    const payout = bet.betAmount + profit;
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [payout, bet.userId]);
  }

  io.emit('roundResults', {
    winners: winners.map(w => ({
      userId: w.userId,
      username: w.username,
      betAmount: w.betAmount,
      cashoutMultiplier: w.cashoutMultiplier,
      payout: w.betAmount + (w.betAmount * (w.cashoutMultiplier - 1) * payoutRatio),
    })),
    losers: losers.map(l => ({
      userId: l.userId,
      username: l.username,
      betAmount: l.betAmount,
    })),
    adminCommission,
  });

  for (const socket of await io.fetchSockets()) {
    const result = await pool.query('SELECT balance FROM users WHERE id = $1', [socket.user.id]);
    if (result.rows.length > 0) socket.emit('balanceUpdate', result.rows[0].balance);
  }
}

// ------------------- Socket Middleware -------------------
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const payload = jwt.verify(token, SECRET_KEY);
    socket.user = payload;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  addLog(`User connected: ${socket.user.username}`);

  (async () => {
    const result = await pool.query('SELECT balance FROM users WHERE id = $1', [socket.user.id]);
    const balance = result.rows.length > 0 ? result.rows[0].balance : 0;

    // --- Send initial state to client ---
    const userBet = currentBets.find(b => b.userId === socket.user.id);
    socket.emit('initPlayerState', {
      balance,
      myBet: userBet ? userBet.betAmount : 0,
      hasCashed: userBet ? userBet.cashedOut : false,
      gameInProgress,
      currentMultiplier: multiplier,
      crashPoint: crashMultiplier,
      logs: gameLogs,
    });
  })();

  // ------------------- Place Bet -------------------
  socket.on('placeBet', async (betAmount) => {
    if (gameInProgress) return socket.emit('betError', 'Betting is closed for this round');

    betAmount = Number(betAmount);
    if (isNaN(betAmount) || betAmount <= 0) return socket.emit('betError', 'Invalid bet amount');

    const result = await pool.query('SELECT balance FROM users WHERE id = $1', [socket.user.id]);
    if (result.rows.length === 0) return socket.emit('betError', 'User not found');
    if (result.rows[0].balance < betAmount) return socket.emit('betError', 'Insufficient balance');

    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [betAmount, socket.user.id]);

    currentBets.push({
      userId: socket.user.id,
      username: socket.user.username,
      betAmount,
      cashoutMultiplier: null,
      cashedOut: false,
      socketId: socket.id,
    });

    socket.emit('betPlaced', betAmount);
    io.emit('currentBetsCount', currentBets.length);
    addLog(`${socket.user.username} placed bet: ${betAmount}`);

    if (currentBets.length >= 2 && !countdownActive && !gameInProgress) startCountdown();
  });

  // ------------------- Cashout -------------------
  socket.on('cashout', () => {
    if (!gameInProgress) return socket.emit('cashoutError', 'No game in progress');

    const bet = currentBets.find(b => b.userId === socket.user.id && !b.cashedOut);
    if (!bet) return socket.emit('cashoutError', 'No active bet found or already cashed out');

    bet.cashedOut = true;
    bet.cashoutMultiplier = multiplier;

    socket.emit('cashedOut', multiplier);
    io.emit('playerCashedOut', { userId: bet.userId, username: bet.username, cashoutMultiplier: multiplier });
    addLog(`${socket.user.username} cashed out at ${multiplier.toFixed(2)}x`);
  });

  socket.on('disconnect', () => {
    addLog(`User disconnected: ${socket.user.username}`);
  });
});

// ------------------ Start Server ------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
