// test-client.js (Updated for Render + HTTPS)
const io = require('socket.io-client');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.log('Usage: node test-client.js <username> <password>');
  process.exit(1);
}

const TOKEN_FILE = path.join(__dirname, 'player_token.json');

// Replace this with your Render server URL
const SERVER_URL = 'https://aviator-game.onrender.com'; 

// Load saved token if it exists
let token = null;
if (fs.existsSync(TOKEN_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    token = saved.token;
    console.log('✅ Using saved token, skipping login...');
  } catch (err) {
    console.error('Failed to read saved token:', err);
  }
}

async function loginAndConnect() {
  if (!token) {
    // Login request
    try {
      const res = await fetch(`${SERVER_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const errData = await res.json();
        console.error('❌ Login failed:', errData.error || res.statusText);
        process.exit(1);
      }

      const data = await res.json();
      token = data.token;

      // Save token to file
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }));
      console.log('✅ Login successful, token saved.');
    } catch (err) {
      console.error('Error during login:', err);
      process.exit(1);
    }
  }

  // Connect with token to Socket.io
  const socket = io(SERVER_URL, {
    auth: { token },
    transports: ['websocket'], // Force WebSocket transport for SSL/HTTPS
  });

  socket.on('connect', () => {
    console.log('✅ Connected to Render server!');
  });

  socket.on('disconnect', () => {
    console.log('⚠️ Disconnected from server!');
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });

  // Multiplayer game events (optional for testing)
  socket.on('countdownStarted', (seconds) => {
    console.log(`⏳ Countdown started: ${seconds}s`);
  });

  socket.on('multiplierUpdate', (value) => {
    console.log(`📈 Multiplier: ${value}x`);
  });

  socket.on('gameCrashed', (finalMultiplier) => {
    console.log(`💥 Game crashed at ${finalMultiplier}x`);
  });

  socket.on('roundResults', (results) => {
    console.log('🏆 Round Results:', results);
  });

  // Example command-line interaction
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('line', async (input) => {
    const parts = input.split(' ');
    const command = parts[0].toLowerCase();

    if (command === 'bet') {
      const amount = parseFloat(parts[1]);
      socket.emit('placeBet', amount);
    } else if (command === 'cashout') {
      socket.emit('cashout');
    } else if (command === 'exit') {
      rl.close();
      socket.disconnect();
      process.exit(0);
    } else {
      console.log('Commands: bet <amount>, cashout, exit');
    }
  });
}

loginAndConnect();
