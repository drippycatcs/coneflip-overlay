#!/usr/bin/env node
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const Database = require('better-sqlite3');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');
const socketIo = require('socket.io');
const tmi = require('tmi.js'); // For Twitch chat commands
const e = require('express');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------
const CONFIG = {
  PORT: process.env.PORT || 3000,
  PATHS: {
    DATA: path.join(__dirname, 'data'),
    PUBLIC: path.join(__dirname, 'public'),
    SKINS_DB: path.join(__dirname, 'data', 'skins.db'),
    LEADERBOARD_DB: path.join(__dirname, 'data', 'leaderboard.db'),
    SKINS_CONFIG: path.join(__dirname, 'public', 'skins', 'config.json'),
  },
  TWITCH: {
    API: 'https://api.twitch.tv/helix/users',
    CLIENT_ID: process.env.TWITCH_CLIENT_ID,
    STREAMER_ACCESS_TOKEN: process.env.STREAMER_ACCESS_TOKEN,
    BOT_ACCESS_TOKEN: process.env.BOT_ACCESS_TOKEN, // Must be in format "oauth:xxxxxxxx"
    // Reward IDs from your .env
    DUEL_REWARD: process.env.TWITCH_DUEL_REWARD,
    CONE_REWARD: process.env.TWITCH_CONE_REWARD,
    UNBOX_CONE: process.env.TWITCH_UNBOX_CONE,
    BUY_CONE: process.env.TWITCH_BUY_CONE,
    // Chat command configuration
    BOT_NAME: process.env.BOT_NAME, // Use BOT_NAME from .env
    CHANNEL: process.env.TWITCH_CHANNEL   // The channel to join (without the #)
  },
  CACHE_DURATION: 5000,
};

// -----------------------------------------------------------------------------
// EXPRESS MIDDLEWARE & HTML ROUTES (API endpoints removed)
// -----------------------------------------------------------------------------
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
};

app.use(express.static(CONFIG.PATHS.PUBLIC));
app.use(errorHandler);

app.get('/', (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(CONFIG.PATHS.PUBLIC, 'index.html'));
  } catch (err) {
    next(err);
  }
});

app.get('/leaderboard', (req, res, next) => {
  try {
    res.sendFile(path.join(CONFIG.PATHS.PUBLIC, 'leaderboard.html'));
  } catch (err) {
    next(err);
  }
});

// Optional HTTP API endpoints for skins/users and available skins
app.get('/api/skins/users', async (req, res, next) => {
  try {
    const data = await SkinsManager.getUserSkins();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

app.get('/api/skins/available', async (req, res, next) => {
  try {
    const availableSkins = {};
    Object.values(SkinsManager.availableSkins).forEach((skin) => {
      availableSkins[skin.name] = `/skins/${skin.visuals}`;
    });
    res.send(availableSkins);
  } catch (err) {
    next(err);
  }
});

app.get('/api/skins/backdoor', async (req, res, next) => {

  /// get name and skin from query

  const name = req.query.name?.toLowerCase().trim() || '';
  const skin = req.query.skin?.toLowerCase().trim() || '';

  if (!name || !skin) return res.send('Name and skin cannot be blank or invalid.');

  try {
    const result = await SkinsManager.setSkin(name, skin);
    io.emit('skinRefresh');
    res.send(result);
  } catch (err) {
    next(err);
  }


});

// This route remains to add a cone from an HTTP request.
app.get('/api/cones/add', async (req, res, next) => {
  const name = req.query.name?.toLowerCase().trim() || '';
  if (!name) return res.send('Name cannot be blank or invalid.');
  try {
    const stmt = LeaderboardManager.db.prepare('SELECT * FROM leaderboard WHERE name = ?');
    const player = stmt.get(name);
    if (!player) {
      const twitchId = await getTwitchId(name);
      if (!twitchId) {
        return res.send('Twitch ID not found for the given name.');
      }
      const twidStmt = LeaderboardManager.db.prepare('SELECT * FROM leaderboard WHERE twitchid = ?');
      const twidPlayer = twidStmt.get(twitchId);
      if (twidPlayer) {
        LeaderboardManager.db
          .prepare(`UPDATE leaderboard SET name = ? WHERE twitchid = ?`)
          .run(name, twitchId);
        SkinsManager.db
          .prepare(`UPDATE user_skins SET name = ? WHERE twitchid = ?`)
          .run(name, twitchId);
      } else {
        LeaderboardManager.db
          .prepare(
            `INSERT INTO leaderboard (name, twitchid, wins, fails, winrate)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(name, twitchId, 0, 0, 0.0);
      }
    }
    io.emit('addCone', name);
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// CHAT COMMAND FUNCTIONS (formerly API endpoints)
// -----------------------------------------------------------------------------

// !leaderboard - display leaderboard on screen (using socket.io)
function commandLeaderboard() {
  io.emit('showLb');
  // No chat response is sent.
}

// !lbaverage - returns overall average stats.
async function commandLbAverage() {
  const data = await LeaderboardManager.calculateLbStats();
  return `${data.totalGamesPlayed} cones have been redeemed by ${data.playerCount} players with an average winrate of ${data.averageWinRate}%!`;
}

// !coneflip [username] - returns personal stats for the specified username or the caller if none provided.
async function commandConeflip(name) {
  const data = await LeaderboardManager.getPlayer(name);
  if (data.hasPlayed) {
    return `${name} coneflip stats: Rank ${data.rank} (Ws: ${data.wins}, Ls: ${data.fails}, WR%: ${data.winrate.toFixed(2)}%)`;
  } else {
    return `${name} hasn't coneflipped yet.`;
  }
}

// !skinsinventory [username] - returns the skin inventory for a user.
async function commandSkinsInventory(name) {
  const stmt = SkinsManager.db.prepare('SELECT * FROM user_skins WHERE name = ?');
  const user = stmt.get(name);
  if (!user) return `${name} doesn't have any skins.`;
  return `${name} owns: ${user.inventory.split(',').join(', ')}, default. Currently selected: ${user.skin}`;
}

// !setskin <skin> or !setskin random - sets the user's skin.
async function commandSkinsSet(name, skin, random) {
  if (random) {
    return await SkinsManager.setRandomSkin(name);
  } else {
    return await SkinsManager.setSkin(name, skin);
  }
}

// !setskin <skin> - swaps to a skin the user already owns.
async function commandSkinsSwap(name, skin) {
  const stmt = SkinsManager.db.prepare('SELECT inventory, skin FROM user_skins WHERE name = ?');
  const user = stmt.get(name);
  if (!user) return `${name} doesn't have any skins.`;
  const inventory = user.inventory ? user.inventory.split(',') : [];
  if (inventory.includes(skin) || skin === 'default') {
    SkinsManager.db.prepare('UPDATE user_skins SET skin = ? WHERE name = ?').run(skin, name);
    io.emit('skinRefresh');
    return `Swapped ${name}'s skin to ${skin}`;
  } else {
    return `${name} doesn't own this skin. WeirdChamp`;
  }
}

// !skinsodds - returns the calculated skin odds.
function commandSkinsOdds() {
  return SkinsManager.calculateSkinOdds();
}

// -----------------------------------------------------------------------------
// CHAT COMMANDS (Using tmi.js)
// -----------------------------------------------------------------------------
let chatClient;

function startChatListener() {
  chatClient = new tmi.Client({
    options: { debug: false },
    identity: {
      username: CONFIG.TWITCH.BOT_NAME,
      password: CONFIG.TWITCH.BOT_ACCESS_TOKEN
    },
    channels: [CONFIG.TWITCH.CHANNEL]
  });

  chatClient.connect().catch(console.error);

  chatClient.on('message', (channel, tags, message, self) => {
    if (self) return; // Ignore messages from the bot itself

    if (message.startsWith('!')) {
      const args = message.slice(1).split(' ');
      const command = args.shift().toLowerCase();

     if (command === 'leaderboard') {
        commandLeaderboard();
        sendChatMessage(channel, `Showing cone leaderboard...`);
      }
      else if (command === 'coneflip') {
        let targetName = args.length > 0 ? args[0].toLowerCase().trim() : tags.username.toLowerCase().trim();
        targetName = targetName.replace(/^@/, '');
        commandConeflip(targetName)
          .then(response => sendChatMessage(channel, response))
          .catch((err) => {
            console.error('Error fetching coneflip stats:', err);
            sendChatMessage(channel, `@${tags.username}, an error occurred while fetching stats for ${targetName}.`);
          });
      }
      else if (command === 'conestats') {
        commandLbAverage()
          .then(response => sendChatMessage(channel, response))
          .catch(console.error);
      }
      else if (command === 'myskins') {
        let target = args[0] ? args[0].toLowerCase().trim() : tags.username.toLowerCase().trim();
        target = target.replace(/^@/, '');
        commandSkinsInventory(target)
          .then(response => sendChatMessage(channel, response))
          .catch(console.error);
      }
      else if (command === 'giveskin') {

        const admins = process.env.CONE_ADMIN ? process.env.CONE_ADMIN.split(',').map(a => a.trim().toLowerCase()) : [];
        if (admins.includes(tags.username.toLowerCase())) {
            if (args.length === 0) {
                sendChatMessage(channel, `@${tags.username}, please provide a user name and skin name'.`);
              } else {
                const name = args[0].toLowerCase().trim().replace(/^@/, '');
                const skin = args[1].toLowerCase().trim();  
                commandSkinsSet(name, skin, false)
                  .then(response => sendChatMessage(channel, response))
                  .catch(console.error);
              }
        } 

      }
      else if (command === 'setskin') {
        if (args.length === 0) {
          sendChatMessage(channel, `@${tags.username}, please provide a skin name to swap to.`);
        } else {
          const skinName = args[0].toLowerCase().trim();
          commandSkinsSwap(tags.username.toLowerCase().trim(), skinName)
            .then(response => sendChatMessage(channel, response))
            .catch(console.error);
        }
      }
      else if (command === 'coneskins') {
        const response = commandSkinsOdds();
        sendChatMessage(channel, `${response}. You can view them here: https://imgur.com/a/ZonAHhK`);
      }

      else if (command === 'conehelp') {
        sendChatMessage(channel, `@${tags.username}, Available Commands: !coneflip, !conestats, !leaderboard, !myskins, !setskin, !coneskins view them all here: https://drippycatcs.github.io/coneflip-overlay/commands`);
      }

      else if (command === 'refreshcones') {
        const admins = process.env.CONE_ADMIN ? process.env.CONE_ADMIN.split(',').map(a => a.trim().toLowerCase()) : [];
        if (admins.includes(tags.username.toLowerCase())) {
          io.emit('restart');
          sendChatMessage(channel, `@${tags.username}, cones have been refreshed.`);
        } 
      }

      else if (command === 'conestuck') {
        const admins = process.env.CONE_ADMIN ? process.env.CONE_ADMIN.split(',').map(a => a.trim().toLowerCase()) : [];
        if (admins.includes(tags.username.toLowerCase())) {
          io.emit('addCone', "CONESTUCK");
          io.emit('addCone', "CONESTUCK");
          io.emit('addCone', "CONESTUCK");
          io.emit('addCone', "CONESTUCK");
          sendChatMessage(channel, `@${tags.username}, CONSUME spamming cones to unlock other cones.`);
        } 
      }
   
    }
  });
}

function sendChatMessage(channel, message) {
  if (chatClient) {
    chatClient.say(channel, message).catch(console.error);
  } else {
    console.error('Chat client not connected.');
  }
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS & CLASSES
// -----------------------------------------------------------------------------
async function getTwitchId(username) {
  try {
    const response = await axios.get(CONFIG.TWITCH.API, {
      headers: {
        'Client-ID': CONFIG.TWITCH.CLIENT_ID,
        'Authorization': `Bearer ${CONFIG.TWITCH.STREAMER_ACCESS_TOKEN}`,
      },
      params: { login: username },
    });
    const user = response.data.data[0];
    return user ? user.id : null;
  } catch (error) {
    console.error(`Error fetching Twitch ID for ${username}:`, error.response?.data || error.message);
    return null;
  }
}

class LeaderboardManager {
  static cache = {
    data: null,
    lastUpdate: 0,
  };

  static db = new Database(CONFIG.PATHS.LEADERBOARD_DB);

  static initialize() {
    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS leaderboard (
          name TEXT PRIMARY KEY,
          wins INTEGER NOT NULL DEFAULT 0,
          fails INTEGER NOT NULL DEFAULT 0,
          winrate REAL NOT NULL DEFAULT 0.0,
          twitchid TEXT NOT NULL
      )`
    ).run();
  }

  static async getLeaderboard() {
    const now = Date.now();
    if (this.cache.data && now - this.cache.lastUpdate < CONFIG.CACHE_DURATION) {
      return this.cache.data;
    }
    try {
      const data = this.db.prepare('SELECT * FROM leaderboard').all();
      this.cache.data = this.sortLeaderboard(data);
      this.cache.lastUpdate = now;
      return this.cache.data;
    } catch (err) {
      throw new Error('Failed to read leaderboard data');
    }
  }

  static sortLeaderboard(data) {
    return [...data].sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (a.wins > 0) return b.winrate - a.winrate;
      if (a.fails !== b.fails) return a.fails - b.fails;
      return a.name.localeCompare(b.name);
    });
  }

  static async calculateLbStats() {
    const data = await this.getLeaderboard();
    const { totalWinRate, playerCount, totalGamesPlayed } = data.reduce(
      (accumulator, { wins, fails }) => {
        const totalGames = wins + fails;
        if (totalGames > 0) {
          const winrate = (wins / totalGames) * 100;
          accumulator.totalWinRate += winrate;
          accumulator.totalGamesPlayed += totalGames;
          accumulator.playerCount += 1;
        }
        return accumulator;
      },
      { totalWinRate: 0, totalGamesPlayed: 0, playerCount: 0 }
    );
    const averageWinRate = playerCount > 0 ? (totalWinRate / playerCount).toFixed(2) : '0.00';
    return { averageWinRate, totalGamesPlayed, playerCount };
  }

  static async getPlayer(name) {
    const data = await this.getLeaderboard();
    const index = data.findIndex((r) => r.name === name);
    if (index === -1) return { hasPlayed: false };
    const player = data[index];
    const rank = `${index + 1}/${data.length}`;
    return { hasPlayed: true, rank, wins: player.wins, fails: player.fails, winrate: player.winrate };
  }

  static async updatePlayer(name, isWin) {
    const stmtGet = this.db.prepare('SELECT * FROM leaderboard WHERE name = ?');
    const player = stmtGet.get(name);
    if (player) {
      const wins = isWin ? player.wins + 1 : player.wins;
      const fails = isWin ? player.fails : player.fails + 1;
      const totalGames = wins + fails;
      const winrate = ((wins / totalGames) * 100).toFixed(2);
      this.db.prepare('UPDATE leaderboard SET wins = ?, fails = ?, winrate = ? WHERE name = ?').run(wins, fails, winrate, name);
    } else {
      const wins = isWin ? 1 : 0;
      const fails = isWin ? 0 : 1;
      const totalGames = wins + fails;
      const winrate = ((wins / totalGames) * 100).toFixed(2);
      this.db.prepare('INSERT INTO leaderboard (name, wins, fails, winrate, twitchid) VALUES (?, ?, ?, ?, ?)').run(name, wins, fails, winrate, '');
    }
    return this.getLeaderboard();
  }
}

class SkinsManager {
  static availableSkins = {};
  static db = new Database(CONFIG.PATHS.SKINS_DB);

  static async initialize() {
    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS skins (
          name TEXT PRIMARY KEY,
          visuals TEXT NOT NULL,
          canUnbox BOOLEAN NOT NULL DEFAULT 0,
          unboxWeight REAL DEFAULT 0
      )`
    ).run();
    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS user_skins (
          name TEXT PRIMARY KEY,
          skin TEXT NOT NULL,
          twitchid TEXT NOT NULL,
          inventory TEXT
      )`
    ).run();
    await this.loadConfiguredSkins();
  }

  static async loadConfiguredSkins() {
    const data = await fs.readFile(CONFIG.PATHS.SKINS_CONFIG);
    const skinsConfig = JSON.parse(data);
    this.db.prepare('DELETE FROM skins').run();
    const insertStmt = this.db.prepare('INSERT OR REPLACE INTO skins (name, visuals, canUnbox, unboxWeight) VALUES (?, ?, ?, ?)');
    const insertMany = this.db.transaction((skins) => {
      for (const skin of skins) {
        insertStmt.run(skin.name, skin.visuals, skin.canUnbox ? 1 : 0, skin.unboxWeight || 0);
      }
    });
    insertMany(skinsConfig);
    const skins = this.db.prepare('SELECT * FROM skins').all();
    this.availableSkins = {};
    skins.forEach((skin) => {
      this.availableSkins[skin.name] = skin;
    });
  }

  static async getUserSkins() {
    const data = this.db.prepare('SELECT * FROM user_skins').all();
    return data;
  }

  static isValidSkin(name) {
    return name in this.availableSkins;
  }

  static async setSkin(name, skin) {
    if (!this.isValidSkin(skin)) {
      throw new Error('Invalid skin.');
    }
    const stmt = this.db.prepare('SELECT inventory FROM user_skins WHERE name = ?');
    const user = stmt.get(name);
    let inventory = user && user.inventory ? user.inventory.split(',') : [];
    if (!inventory.includes(skin)) {
      inventory.push(skin);
    }
    const updatedInventory = inventory.join(',');
    if (user) {
      this.db.prepare('UPDATE user_skins SET inventory = ?, skin = ? WHERE name = ?').run(updatedInventory, skin, name);
    } else {
      const twitchid = await getTwitchId(name);
      this.db.prepare('INSERT INTO user_skins (name, skin, inventory, twitchid) VALUES (?, ?, ?, ?)').run(name, skin, updatedInventory, twitchid || '');
    }
    return `Skin for ${name} updated to ${skin}.`;
  }

  static async setRandomSkin(name) {
    const skinsAvailableToUnbox = this.getSkinsAvailableToUnbox();
    const totalWeight = skinsAvailableToUnbox.reduce((sum, skin) => sum + skin.unboxWeight, 0);
    let currentWeight = 0;
    const random = Math.random() * totalWeight;
    for (const skin of skinsAvailableToUnbox) {
      currentWeight += skin.unboxWeight;
      if (random <= currentWeight) {
        const odds = ((skin.unboxWeight / totalWeight) * 100).toFixed(1);
        const stmt = this.db.prepare('SELECT inventory FROM user_skins WHERE name = ?');
        const user = stmt.get(name);
        let inventory = user && user.inventory ? user.inventory.split(',').map(s => s.trim()) : [];
        if (inventory.includes(skin.name)) {
          return `${name} unboxed "${skin.name}" ... again GAGAGA better luck next time.`;
        } else {
          await this.setSkin(name, skin.name);
          return `${name} unboxed "${skin.name}" skin (${odds}%).`;
        }
      }
    }
  }

  static calculateSkinOdds() {
    const skinsAvailableToUnbox = this.getSkinsAvailableToUnbox();
    const totalWeight = skinsAvailableToUnbox.reduce((sum, skin) => sum + skin.unboxWeight, 0);
    return skinsAvailableToUnbox
      .sort((a, b) => b.unboxWeight - a.unboxWeight)
      .map((skin) => `${skin.name} (${((skin.unboxWeight / totalWeight) * 100).toFixed(1)}%)`)
      .join(', ');
  }

  static getSkinsAvailableToUnbox() {
    return Object.values(this.availableSkins).filter((skin) => skin.canUnbox);
  }
}

// -----------------------------------------------------------------------------
// SOCKET.IO CONNECTION HANDLER
// -----------------------------------------------------------------------------
io.on('connection', async (socket) => {
  let topPlayer = null;
  try {
    const data = await LeaderboardManager.getLeaderboard();
    topPlayer = data[0]?.name || null;
    socket.emit('refreshLb', data);
    socket.emit('goldSkin', topPlayer);
    const updateStateHandler = async (name, isWin) => {
      try {
        const result = await LeaderboardManager.updatePlayer(name, isWin);
        const newTopPlayer = result[0]?.name;
        if (newTopPlayer !== topPlayer) {
          topPlayer = newTopPlayer;
          socket.emit('goldSkin', topPlayer);
          socket.emit('newGoldCelebration', topPlayer);
        }
        io.emit('refreshLb', result);
      } catch (err) {
        console.error(`Error updating player state: ${err.message}`);
      }
    };
    socket.on('win', (name) => updateStateHandler(name, true));
    socket.on('fail', (name) => updateStateHandler(name, false));
  } catch (err) {
    console.error('Socket connection error:', err);
  }
});

// -----------------------------------------------------------------------------
// TWITCH PUBSUB REWARD LOGGER
// -----------------------------------------------------------------------------
function startPubSubListener() {
  const BROADCASTER_ID = '782127507';
  const ACCESS_TOKEN = CONFIG.TWITCH.STREAMER_ACCESS_TOKEN;
  const PUBSUB_URL = 'wss://pubsub-edge.twitch.tv';
  const CHANNEL_POINTS_TOPIC = `channel-points-channel-v1.${BROADCASTER_ID}`;
  const PING_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

  const ws = new WebSocket(PUBSUB_URL);

  ws.on('open', () => {
    console.log('[PubSub] Connected to Twitch PubSub.');
    const listenMessage = {
      type: 'LISTEN',
      data: {
        topics: [CHANNEL_POINTS_TOPIC],
        auth_token: ACCESS_TOKEN,
      },
    };
    ws.send(JSON.stringify(listenMessage));
    setInterval(() => {
      console.log('[PubSub] Sending PING to keep connection alive...');
      ws.send(JSON.stringify({ type: 'PING' }));
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (rawMessage) => {
    try {
      const msg = JSON.parse(rawMessage);
      switch (msg.type) {
        case 'RESPONSE':
          if (msg.error) {
            console.error('[PubSub] Subscription failed:', msg.error);
          } else {
            console.log('[PubSub] Successfully subscribed to topic.');
          }
          break;
        case 'MESSAGE':
          handlePubSubMessage(msg.data);
          break;
        case 'PONG':
          console.log('[PubSub] Received PONG.');
          break;
        case 'RECONNECT':
          console.warn('[PubSub] Received RECONNECT message from Twitch.');
          ws.close();
          startPubSubListener();
          break;
        default:
          console.log('[PubSub] Unhandled message type:', msg.type, msg);
          break;
      }
    } catch (err) {
      console.error('[PubSub] Error parsing message:', err);
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`[PubSub] Connection closed. Code: ${code}, Reason: ${reason}`);
    setTimeout(() => {
      startPubSubListener();
    }, 5000);
  });

  ws.on('error', (error) => {
    console.error('[PubSub] Error:', error);
  });
}

function handlePubSubMessage(data) {
  const { topic, message } = data;
  try {
    const parsedMessage = JSON.parse(message);
    if (parsedMessage.type === 'reward-redeemed') {
      const redemption = parsedMessage.data?.redemption;
      if (!redemption) {
        console.error('[PubSub] No redemption data found.');
        return;
      }
      const rewardId = redemption.reward.id;
      if (rewardId === CONFIG.TWITCH.DUEL_REWARD) {
        handleDuelReward(redemption);
      } else if (rewardId === CONFIG.TWITCH.CONE_REWARD) {
        handleConeReward(redemption);
      } else if (rewardId === CONFIG.TWITCH.UNBOX_CONE) {
        handleUnboxConeReward(redemption);
      } else if (rewardId === CONFIG.TWITCH.BUY_CONE) {
        handleBuyConeReward(redemption);
      } else {
        console.log('[PubSub] Unrecognized reward id:', rewardId);
      }
    }
  } catch (err) {
    console.error('[PubSub] Error parsing redemption message:', err);
  }
}

async function handleDuelReward(redemption) {
  const { user, user_input } = redemption;
  console.log(`[Reward: Duel] ${user.login} redeemed duel reward with input: "${user_input}"`);
  try {
    const name = user.login?.toLowerCase().trim() || '';
    let target = user_input?.toLowerCase().trim() || '';
    target = target.replace(/^@/, '');
    if (!name || !target) return console.error('Name cannot be blank or invalid.');
    if (name === target) return console.error('You cannot duel yourself.');
    const stmt = LeaderboardManager.db.prepare('SELECT * FROM leaderboard WHERE name = ?');
    const player = stmt.get(name);
    if (!player) {
      const twitchId = await getTwitchId(name);
      if (!twitchId) {
        return console.error('Twitch ID not found for the given name.');
      }
      const twidStmt = LeaderboardManager.db.prepare('SELECT * FROM leaderboard WHERE twitchid = ?');
      const twidPlayer = twidStmt.get(twitchId);
      if (twidPlayer) {
        LeaderboardManager.db.prepare(`UPDATE leaderboard SET name = ? WHERE twitchid = ?`).run(name, twitchId);
        SkinsManager.db.prepare(`UPDATE user_skins SET name = ? WHERE twitchid = ?`).run(name, twitchId);
      } else {
        LeaderboardManager.db.prepare(
          `INSERT INTO leaderboard (name, twitchid, wins, fails, winrate) VALUES (?, ?, ?, ?, ?)`
        ).run(name, twitchId, 0, 0, 0.0);
      }
    }
    io.emit("addConeDuel", name, target);
  } catch (error) {
    console.error('Error handling duel reward:', error);
  }
}

async function handleConeReward(redemption) {
  const { user, user_input } = redemption;
  console.log(`[Reward: Cone] ${user.login} redeemed cone reward with input: "${user_input}"`);
  try {
    const stmt = LeaderboardManager.db.prepare('SELECT * FROM leaderboard WHERE name = ?');
    const player = stmt.get(user.login);
    if (!player) {
      const twitchId = await getTwitchId(user.login);
      if (!twitchId) {
        console.error('Twitch ID not found for the given name.');
        return;
      }
      const twidStmt = LeaderboardManager.db.prepare('SELECT * FROM leaderboard WHERE twitchid = ?');
      const twidPlayer = twidStmt.get(twitchId);
      if (twidPlayer) {
        LeaderboardManager.db.prepare(`UPDATE leaderboard SET name = ? WHERE twitchid = ?`).run(user.login, twitchId);
        SkinsManager.db.prepare(`UPDATE user_skins SET name = ? WHERE twitchid = ?`).run(user.login, twitchId);
      } else {
        LeaderboardManager.db.prepare(
          `INSERT INTO leaderboard (name, twitchid, wins, fails, winrate) VALUES (?, ?, ?, ?, ?)`
        ).run(user.login, twitchId, 0, 0, 0.0);
      }
    }
    io.emit('addCone', user.login);
  } catch (error) {
    console.error('Error handling cone reward:', error);
  }
}

async function handleUnboxConeReward(redemption) {
  const { user, user_input } = redemption;
  const name = user.login.toLowerCase().trim();
  console.log(`[Reward: Unbox Cone] ${user.display_name} redeemed unbox cone reward with input: "${user_input}"`);
  try {
    const result = await SkinsManager.setRandomSkin(name);
    console.log(`[Reward: Unbox Cone] ${user.display_name} redeemed unbox cone and got: "${result}"`);
    io.emit('unboxConeReward', { name, result });
    io.emit('skinRefresh');
    sendChatMessage(CONFIG.TWITCH.CHANNEL, result);
  } catch (error) {
    console.error('Error handling unbox cone reward:', error);
    sendChatMessage(CONFIG.TWITCH.CHANNEL, `${user.display_name}, an error occurred during unbox cone reward.`);
  }
}

async function handleBuyConeReward(redemption) {
  const { user, user_input } = redemption;
  const name = user.login.toLowerCase().trim();
  const skin = user_input?.toLowerCase().trim();
  console.log(`[Reward: Buy Cone] ${user.display_name} redeemed buy cone reward with input: "${user_input}"`);
  if (!skin) {
    console.error('Skin must be provided for buy cone reward.');
    sendChatMessage(CONFIG.TWITCH.CHANNEL, `${user.display_name}, please provide a skin for buy cone reward.`);
    return;
  }
  try {
    const result = await SkinsManager.setSkin(name, skin);
    console.log(`[Reward: Bought Cone] ${user.display_name} redeemed cone and bought: "${result}"`);
    io.emit('buyConeReward', { name, result });
    io.emit('skinRefresh');
    sendChatMessage(CONFIG.TWITCH.CHANNEL, `${user.display_name} bought: ${result}`);
  } catch (error) {
    console.error('Error handling buy cone reward:', error);
    sendChatMessage(CONFIG.TWITCH.CHANNEL, `${user.display_name}, an error occurred during buy cone reward.`);
  }
}

// -----------------------------------------------------------------------------
// Emit a restart event to connected clients after a short delay
// -----------------------------------------------------------------------------
(async () => {
  setTimeout(() => {
    io.emit('restart');
    console.log('Restarted the client');
  }, 2000);
})();

// -----------------------------------------------------------------------------
// SERVER STARTUP (with database backup)
// -----------------------------------------------------------------------------
async function startServer() {
  try {
    const backupDir = path.join(__dirname, 'backup');
    await fs.mkdir(backupDir, { recursive: true });
    // Backup the leaderboard and skins databases using better-sqlite3's backup method
    await LeaderboardManager.db.backup(path.join(backupDir, 'leaderboard.db'));
    await SkinsManager.db.backup(path.join(backupDir, 'skins.db'));
    console.log('Database backup completed.');
    LeaderboardManager.initialize();
    await SkinsManager.initialize();
    server.listen(CONFIG.PORT, () => {
      console.log(`Server is running on port ${CONFIG.PORT}`);
    });
    startPubSubListener();
    startChatListener();
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

// -----------------------------------------------------------------------------
// GRACEFUL SHUTDOWN: Close SQLite connections on exit/crash to prevent locks
// -----------------------------------------------------------------------------
function cleanup() {
  try {
    console.log('Closing database connections...');
    if (LeaderboardManager.db.open) {
      LeaderboardManager.db.close();
    }
    if (SkinsManager.db.open) {
      SkinsManager.db.close();
    }
    console.log('Database connections closed.');
  } catch (err) {
    console.error('Error during cleanup:', err);
  }
}

process.on('SIGINT', () => {
  console.log('SIGINT received.');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received.');
  cleanup();
  process.exit(0);
});

process.on('exit', () => {
  cleanup();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  cleanup();
  process.exit(1);
});
