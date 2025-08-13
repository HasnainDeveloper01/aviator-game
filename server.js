// server.js (Render + Hostinger ready)
const express = require('express');
const http = require('http');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');



const { Server } = require('socket.io');
require('dotenv').config();


const app = express();
app.use(cors());
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY || 'asdfghjqwerty'; // Use ENV variable for security

// MySQL connection pool using Hostinger DB
const pool = mysql.createPool({
  connectionLimit: 10,
  host: process.env.DB_HOST,     // e.g., mysql.hostinger.com
  user: process.env.DB_USER,     // e.g., u764685979_aviator_admin
  password: process.env.DB_PASS, // your password
  database: process.env.DB_NAME, // e.g., u764685979_aviator_db
});



// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------ Signup API ------------------
app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  try {
    const hashedPassword = await bcrypt.hash(password, 8);
    await pool.query(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username, hashedPassword]
    );
    res.json({ message: 'User registered successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Username already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------ Login API ------------------
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0) return res.status(400).json({ error: 'Invalid credentials' });

    const user = rows[0];
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1d' });
    res.json({ token, balance: user.balance });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------ Admin APIs ------------------
// Set balance
app.post('/admin/set-balance', async (req, res) => {
  try {
    const { username, balance } = req.body;
    if (!username || isNaN(balance)) return res.status(400).json({ error: 'Invalid username or balance' });

    const [result] = await pool.query('UPDATE users SET balance = ? WHERE username = ?', [balance, username]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ message: 'Balance updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get users
app.get('/admin/get-users', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, balance FROM users');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update user
app.put('/admin/update-user/:id', async (req, res) => {
  const { id } = req.params;
  const { username, password, balance } = req.body;

  try {
    let sql, params;

    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      sql = "UPDATE users SET username = ?, password = ?, balance = ? WHERE id = ?";
      params = [username, hashedPassword, balance, id];
    } else {
      sql = "UPDATE users SET username = ?, balance = ? WHERE id = ?";
      params = [username, balance, id];
    }

    const [result] = await pool.query(sql, params);
    if (result.affectedRows > 0) res.json({ success: true, message: "User updated successfully" });
    else res.status(404).json({ success: false, message: "User not found" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// Delete user
app.delete('/admin/delete-user/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------ Socket.io Multiplayer Game Logic ------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Game state variables
let currentBets = [];
let countdownTimer = null;
let countdownSeconds = 10;
let countdownActive = false;
let multiplier = 1.0;
let multiplierInterval = null;
let gameInProgress = false;
let crashMultiplier = 0;

// Countdown
function startCountdown() {
  if (countdownActive) return;
  countdownActive = true;
  countdownSeconds = 10;
  crashMultiplier = +(Math.random() * 8.5 + 1.5).toFixed(2);

  io.emit('countdownStarted', countdownSeconds);
  io.emit('crashPoint', crashMultiplier);

  countdownTimer = setInterval(() => {
    countdownSeconds--;
    io.emit('countdownTick', countdownSeconds);

    if (countdownSeconds <= 0) {
      clearInterval(countdownTimer);
      countdownActive = false;
      io.emit('countdownEnded');

      if (currentBets.length > 0) startMultiplier();
      else currentBets = [];
    }
  }, 1000);
}

// Multiplier logic
function startMultiplier() {
  if (gameInProgress) return;
  multiplier = 1.0;
  gameInProgress = true;
  io.emit('multiplierUpdate', multiplier);

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

// Crash logic
function crashGame() {
  clearInterval(multiplierInterval);
  multiplierInterval = null;
  gameInProgress = false;
  io.emit('gameCrashed', multiplier);
  calculatePayouts();
  currentBets = [];
}

// Payout calculation
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
    await pool.query('UPDATE users SET balance = balance + ? WHERE id = ?', [payout, bet.userId]);
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

  // Update balances to connected sockets
  for (const socket of await io.fetchSockets()) {
    const [rows] = await pool.query('SELECT balance FROM users WHERE id = ?', [socket.user.id]);
    if (rows.length > 0) socket.emit('balanceUpdate', rows[0].balance);
  }
}

// Socket.io auth middleware
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
  console.log(`User connected: ${socket.user.username}`);

  (async () => {
    const [rows] = await pool.query('SELECT balance FROM users WHERE id = ?', [socket.user.id]);
    if (rows.length > 0) socket.emit('balanceUpdate', rows[0].balance);
  })();

  socket.on('placeBet', async (betAmount) => {
    if (gameInProgress) return socket.emit('betError', 'Betting is closed for this round');

    betAmount = Number(betAmount);
    if (isNaN(betAmount) || betAmount <= 0) return socket.emit('betError', 'Invalid bet amount');

    const [rows] = await pool.query('SELECT balance FROM users WHERE id = ?', [socket.user.id]);
    if (rows.length === 0) return socket.emit('betError', 'User not found');
    if (rows[0].balance < betAmount) return socket.emit('betError', 'Insufficient balance');

    await pool.query('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, socket.user.id]);

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

    if (currentBets.length >= 2 && !countdownActive && !gameInProgress) startCountdown();
  });

  socket.on('cashout', () => {
    if (!gameInProgress) return socket.emit('cashoutError', 'No game in progress');

    const bet = currentBets.find(b => b.userId === socket.user.id && !b.cashedOut);
    if (!bet) return socket.emit('cashoutError', 'No active bet found or already cashed out');

    bet.cashedOut = true;
    bet.cashoutMultiplier = multiplier;

    socket.emit('cashedOut', multiplier);
    io.emit('playerCashedOut', { userId: bet.userId, username: bet.username, cashoutMultiplier: multiplier });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.user.username}`);
  });
});

// ------------------ Start Server ------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
