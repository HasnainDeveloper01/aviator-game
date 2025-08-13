// test-client.js
const io = require('socket.io-client');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.log('Usage: node test-client.js <username> <password>');
  process.exit(1);
}

const TOKEN_FILE = path.join(__dirname, 'player_token.json');

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
      const res = await fetch('http://localhost:3000/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        console.error('❌ Login failed');
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

  // Connect with token
  const socket = io('http://localhost:3000', {
    auth: { token }
  });

  socket.on('connect', () => {
    console.log('Connected to server!');
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server!');
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });
}

loginAndConnect();
