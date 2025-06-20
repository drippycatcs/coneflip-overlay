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
const tmi = require('tmi.js');
const e = require('express');

// EventSub dependencies
const { EventSubWsListener } = require('@twurple/eventsub-ws');
const { ApiClient } = require('@twurple/api');
const { StaticAuthProvider } = require('@twurple/auth');

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
    BOT_ACCESS_TOKEN: process.env.BOT_ACCESS_TOKEN,
    DUEL_REWARD: process.env.TWITCH_DUEL_REWARD,
    CONE_REWARD: process.env.TWITCH_CONE_REWARD,
    UNBOX_CONE: process.env.TWITCH_UNBOX_CONE,
    BUY_CONE: process.env.TWITCH_BUY_CONE,
    BOT_NAME: process.env.BOT_NAME,
    CHANNEL: process.env.TWITCH_CHANNEL,
    SEVENTV_TOKEN: process.env.SEVENTV_TOKEN,
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

app.get('/gamba', (req, res, next) => {
  try {
    res.sendFile(path.join(CONFIG.PATHS.PUBLIC, 'unbox.html'));
  } catch (err) {
    next(err);
  }
});

app.get('/api/leaderboard', async (req, res, next) => {
  const name = req.query.name?.toLowerCase().trim() || '';
  const show = req.query.show === 'true';

  try {
    if (show) {
      io.emit('showLb');
      return res.sendStatus(200);
    }

    if (name) {
      let result;
      const data = await LeaderboardManager.getPlayer(name);
      if (data.hasPlayed) {
        result = `${name} cone stats: ${data.rank} (Ws: ${data.wins} / Ls: ${data.fails} / WR%: ${data.winrate.toFixed(
          2
        )})`;
      } else {
        result = `${name} never tried coneflipping.`;
      }
      return res.send(result);
    }

    const data = await LeaderboardManager.getLeaderboard();
    res.json(data);
  } catch (err) {
    next(err);
  }
});
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

app.get('/api/skins/give', async (req, res, next) => {
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

app.get('/debug/', async (req, res, next) => {
  const name = req.query.name?.toLowerCase().trim() || '';

  try {
    await SkinsManager.setRandomSkin(name);
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

app.get('/api/7tv/paint', async (req, res, next) => {
  const name = req.query.name?.toLowerCase().trim() || '';

  try {
    const paintData = await getUserPaintsAndBadge(name);
    if (paintData && paintData.username && paintData.username.toLowerCase() !== name) {
      return res.send({ message: 'No active paint set.', username: paintData.username });
    }
    res.send(paintData);
  } catch (err) {
    next(err);
  }
});
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

app.get('/api/cones/duel', async (req, res, next) => {
  const name = req.query.name?.toLowerCase().trim() || '';
  const target = req.query.target?.toLowerCase().trim() || '';
  if (!name || !target) return res.send('Name and target cannot be blank or invalid.');
  if (name === target) return res.send('You cannot duel yourself.');
  io.emit("addConeDuel", name, target);
  res.sendStatus(200);
});

app.get('/api/7tv/emote', async (req, res, next) => {
  const name = req.query.name?.toLowerCase().trim() || '';

  try {
    const emoteMap = await getStreamerEmoteList();
    const isEmote = name in emoteMap;
    res.json({
      isEmote,
      url: isEmote ? emoteMap[name] : null
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// CHAT COMMAND FUNCTIONS (formerly API endpoints)
// -----------------------------------------------------------------------------
function commandLeaderboard(target) {
  io.emit('showLb', target);
}

async function commandLbAverage() {
  const data = await LeaderboardManager.calculateLbStats();
  return `${data.totalGamesPlayed} cones have been redeemed by ${data.playerCount} players with an average winrate of ${data.averageWinRate}%!`;
}

async function commandConeflip(name) {
  const data = await LeaderboardManager.getPlayer(name);
  if (data.hasPlayed) {
    return `${name} coneflip stats: Rank ${data.rank} (Ws: ${data.wins}, Ls: ${data.fails}, WR%: ${data.winrate.toFixed(2)}%).`;
  } else {
    return `${name} hasn't coneflipped yet.`;
  }
}

async function commandSkinsInventory(name) {
  const stmt = SkinsManager.db.prepare('SELECT * FROM user_skins WHERE name = ?');
  const user = stmt.get(name);
  if (!user) return `${name} doesn't have any skins.`;

  let skins = user.inventory.split(',').map(skin => skin.trim()).filter(skin => skin);

  if ((await isSub(name)) > 0 && !skins.includes('subcone')) {
    skins.push('subcone');
  }

  const leaderboard = await LeaderboardManager.getLeaderboard();
  if (leaderboard[0]?.name === name && !skins.includes('gold')) {
    skins.push('gold');
  }
  skins.push('pride');
  return `${name} owns: ${skins.join(', ')} | Currently selected: ${user.skin}`;
}

async function commandSkinsSet(name, skin, random) {
  if (random) {
    return await SkinsManager.setRandomSkin(name);
  } else {
    return await SkinsManager.setSkin(name, skin);
  }
}

async function commandSkinsSwap(name, skin) {
  skin = skin.trim();

  const stmt = SkinsManager.db.prepare('SELECT inventory, skin FROM user_skins WHERE name = ?');
  const user = stmt.get(name);
  if (!user) return `${name} doesn't have any skins.`;

  let inventory = user.inventory
    ? user.inventory.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  let checkInventory = [...inventory];

  if ((await isSub(name)) > 0 && !checkInventory.includes("subcone")) {
    checkInventory.push("subcone");
    console.log(`Dynamically added "subcone" for ${name}.`);
  }

  const leaderboard = await LeaderboardManager.getLeaderboard();
  if (leaderboard[0]?.name === name && !checkInventory.includes("gold")) {
    checkInventory.push("gold");
    console.log(`Dynamically added "gold" for ${name}.`);
  }

  if (checkInventory.includes(skin) || skin === 'default' || skin === 'pride') {
    SkinsManager.db.prepare('UPDATE user_skins SET skin = ? WHERE name = ?').run(skin, name);
    io.emit('skinRefresh');
    return `Swapped ${name}'s skin to ${skin}.`;
  } else {
    return `${name} doesn't own this skin. WeirdChamp .`;
  }
}

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

   
    if (typeof message === 'string' && message.startsWith('!')) {
      const args = message.slice(1).split(' ');
      const command = args.shift().toLowerCase();
      if (command === 'leaderboard') {
        let target = args[0] ? args[0].toLowerCase().trim() : tags.username.toLowerCase().trim();
        target = target.replace(/^@/, '');
        commandLeaderboard(target);

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
          if (!Array.isArray(args) || args.length < 2) {
            console.log(`${tags.username} used !giveskin but failed to provide correct input.`);
            return;
          } else {
            const name = typeof args[0] === 'string' ? args[0].toLowerCase().trim().replace(/^@/, '') : '';
            const skin = typeof args[1] === 'string' ? args[1].toLowerCase().trim() : '';
            if (!name || !skin) {
              console.log(`${tags.username} used !giveskin but failed to provide correct input.`);
              return;
            }
            commandSkinsSet(name, skin, false)
              .then(response => sendChatMessage(channel, response))
              .catch(console.error);
          }
        }
      }
      else if (command === 'simcone') {
        const admins = process.env.CONE_ADMIN ? process.env.CONE_ADMIN.split(',').map(a => a.trim().toLowerCase()) : [];
        if (admins.includes(tags.username.toLowerCase())) {
          if (!Array.isArray(args) || args.length < 1) {
            console.log(`${tags.username} used !simcone but failed to provide correct input.`);
            return;
          } else {
            const name = typeof args[0] === 'string' ? args[0].toLowerCase().trim().replace(/^@/, '') : '';
            if (!name) {
              console.log(`${tags.username} used !simcone but failed to provide correct input.`);
              return;
            }
            io.emit('addCone', name);
          }
        }
      }
      else if (command === 'simduel') {
        const admins = process.env.CONE_ADMIN ? process.env.CONE_ADMIN.split(',').map(a => a.trim().toLowerCase()) : [];
        if (admins.includes(tags.username.toLowerCase())) {
          if (!Array.isArray(args) || args.length < 2) {
            console.log(`${tags.username} used !simduel but failed to provide correct input.`);
            return;
          } else {
            const name = typeof args[0] === 'string' ? args[0].toLowerCase().trim().replace(/^@/, '') : '';
            const target = typeof args[1] === 'string' ? args[1].toLowerCase().trim().replace(/^@/, '') : '';
            if (!name || !target) {
              console.log(`${tags.username} used !simduel but failed to provide correct input.`);
              return;
            } else if (name === target) {
              sendChatMessage(channel, `@${tags.username}, you cannot duel yourself.`);
            } else {
              io.emit("addConeDuel", name, target);
            }
          }
        }
      }
      else if (command === 'setskin') {
        if (!Array.isArray(args) || args.length < 1) {
          console.log(`${tags.username} used !setskin but failed to provide correct input.`);
          return;
        } else {
          const skinName = typeof args[0] === 'string' ? args[0].toLowerCase().trim() : '';
          if (!skinName) {
            console.log(`${tags.username} used !setskin but failed to provide correct input.`);
            return;
          }
          commandSkinsSwap(tags.username.toLowerCase().trim(), skinName)
            .then(response => sendChatMessage(channel, response))
            .catch(console.error);
        }
      }
      else if (command === 'coneskins') {
        const response = commandSkinsOdds();
        sendChatMessage(channel, `@${tags.username}, You can view cone skins here: https://drippycatcs.github.io/coneflip-overlay/commands#-cone-skins  Use !myskins to view your owned skins`);
      }
      else if (command === 'conehelp') {
        sendChatMessage(channel, `@${tags.username}, Available commands: coneflip, conestats, leaderboard, myskins, setskin, coneskins view them all here: https://drippycatcs.github.io/coneflip-overlay/commands .`);
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

      } else if (command === '@drippycatcs') {
        sendChatMessage(channel, `@${tags.username}, Hi drippycat debug agent here. Ask a mod to try !refreshcones if there are any issues. If this doesn't help please DM drippycat on discord. If Drippycat doesn't fix it within 15 minutes this script is developed to automatically bomb his appartment. Type !bombdrippycat to initiate the process.`);
      }
    } else if (message.startsWith('@drippycatcs')) {

      if (message.toLowerCase().includes('cone')) {
        sendChatMessage(channel, `@${tags.username}, Hi drippycat debug agent here. Ask a mod to try !refreshcones if there are any issues. If this doesn't help please DM drippycat on discord. If Drippycat doesn't fix it within 15 minutes this script is developed to automatically bomb his appartment. Type !bombdrippycat to initiate the process.`);
      }

    }
  });
}

function sendChatMessage(channel, message) {
  if (chatClient) {
    chatClient.say(channel, `> ${message}`).catch(console.error);
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

/**
 * Checks the subscription status for a given username and returns the subscription tier.
 * Returns:
 *   0 - Not subscribed
 *   1 - Tier 1 subscription (tier value "1000")
 *   2 - Tier 2 subscription (tier value "2000")
 *   3 - Tier 3 subscription (tier value "3000")
 * @param {string} username - The Twitch username to check.
 * @returns {Promise<number>} - The subscription tier as a number.
 */
async function isSub(username) {
  try {
    const userId = await getTwitchId(username);
    const channelId = await getTwitchId(CONFIG.TWITCH.CHANNEL_NAME);

    if (!userId || !channelId) {
      console.error("Failed to retrieve valid user or channel ID.");
      return false;
    }

    const response = await axios.get(`https://api.twitch.tv/helix/subscriptions`, {
      headers: {
        'Client-ID': CONFIG.TWITCH.CLIENT_ID,
        'Authorization': `Bearer ${CONFIG.TWITCH.STREAMER_ACCESS_TOKEN}`,
        'Accept': 'application/json'
      },
      params: {
        broadcaster_id: channelId,
        user_id: userId,
      },
    });

    if (response.data.data && response.data.data.length > 0) {
      const sub = response.data.data[0];
      switch (sub.tier) {
        case "1000":
          return 1;
        case "2000":
          return 2;
        case "3000":
          return 3;
        default:
          console.error(`Unexpected subscription tier value: ${sub.tier}`);
          return 0;
      }
    } else {
      return 0;
    }
  } catch (error) {
    console.error(`Error checking subscription status for ${username}:`, error.response?.data || error.message);
    return 0;
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
          io.emit('unboxSkinAnim', skin.name, name, `${name} unboxed "${skin.name}" ... again (${odds}%) GAGAGA Better luck next time... `);
          return `${name} unboxed "${skin.name}" ... again GAGAGA better luck next time (${odds}%)..`;
        } else {
          await this.setSkin(name, skin.name);
          io.emit('unboxSkinAnim', skin.name, name, `${name} unboxed "${skin.name}" skin (${odds}%).`);
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
// 7TV Integration
// -----------------------------------------------------------------------------
async function getUserPaintsAndBadge(twitchUsername) {
  try {
    // Fetch user ID by Twitch username
    const fetchUserQuery = `
      query FetchUser($username: String!) {
        users(query: $username) {
          id
          username
        }
      }
    `;
    const userResponse = await axios.post(
      'https://7tv.io/v3/gql',
      {
        operationName: 'FetchUser',
        query: fetchUserQuery,
        variables: { username: twitchUsername }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.TWITCH.SEVENTV_TOKEN}`
        }
      }
    );

    if (userResponse.data.errors || !userResponse.data.data.users.length) {
      console.error('Error fetching user or user not found:', userResponse.data.errors);
      return;
    }
    const userId = userResponse.data.data.users[0].id;

    // Fetch user paint and badge information using userId
    const fetchUserPaintQuery = `
      query GetUserForUserPage($id: ObjectID!) {
        user(id: $id) {
          id
          username
          display_name
          avatar_url
          style {
            color
            paint {
              id
              kind
              name
              function
              color
              angle
              shape
              image_url
              repeat
              stops {
                at
                color
              }
              shadows {
                x_offset
                y_offset
                radius
                color
              }
            }
            badge {
              id
              kind
              name
              tooltip
              tag
            }
          }
        }
      }
    `;
    const paintResponse = await axios.post(
      'https://7tv.io/v3/gql',
      {
        query: fetchUserPaintQuery,
        variables: { id: userId }
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    if (paintResponse.data.errors) {
      console.error('GraphQL Errors:', paintResponse.data.errors);
      return;
    }

    const userData = paintResponse.data.data.user;
    if (!userData) {
      console.error('User data not found.');
      return;
    }

    // Format paint details into JSON format
    let paintDetails;
    const paint = userData.style.paint;
    if (!paint) {
      paintDetails = { message: 'No active paint set.' };
    } else {
      paintDetails = {
        name: paint.name,
        kind: paint.kind,
        function: paint.function,
        shape: paint.shape
      };

      if (paint.function === 'LINEAR_GRADIENT' || paint.function === 'RADIAL_GRADIENT') {
        paintDetails.gradientAngle = paint.angle || 'N/A';
        if (paint.stops && paint.stops.length) {
          paintDetails.gradientStops = paint.stops.map((stop, index) => ({
            order: index + 1,
            at: stop.at * 100 + '%',
            color: stop.color
          }));
        } else {
          paintDetails.gradientStops = [];
        }
      } else {
        paintDetails.color = paint.color || 'N/A';
      }

      if (paint.image_url) {
        paintDetails.image = paint.image_url;
      }

      if (paint.shadows && paint.shadows.length) {
        paintDetails.shadows = paint.shadows.map(shadow => ({
          x_offset: shadow.x_offset,
          y_offset: shadow.y_offset,
          radius: shadow.radius,
          color: shadow.color
        }));
      } else {
        paintDetails.shadows = [];
      }
    }


    paintDetails.username = userData.username;

    return paintDetails;
  } catch (error) {
    console.error('Error in getUserPaintsAndBadge:', error.message);
    throw error;
  }
}

// Fetch 7TV global emotes
async function getGlobal7TVEmotes() {
  try {
    const response = await axios.get('https://7tv.io/v3/emote-sets/global');
    if (!response.data || !response.data.emotes) return {};
    const emoteMap = {};
    response.data.emotes.forEach(emote => {
      if (emote.name && emote.data && emote.data.host && emote.data.host.url) {
        emoteMap[emote.name.toLowerCase()] = `${emote.data.host.url}/4x.webp`;
      }
    });
    return emoteMap;
  } catch (err) {
    console.error('Error fetching 7TV global emotes:', err);
    return {};
  }
}

// Update getStreamerEmoteList to merge global emotes
async function getStreamerEmoteList() {
  try {
    // Fetch streamer's 7TV user ID
    const fetchUserQuery = `
      query FetchUser($username: String!) {
        users(query: $username) {
          id
          username
        }
      }
    `;
    const userResponse = await axios.post(
      'https://7tv.io/v3/gql',
      {
        operationName: 'FetchUser',
        query: fetchUserQuery,
        variables: { username: CONFIG.TWITCH.CHANNEL }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.TWITCH.SEVENTV_TOKEN}`
        }
      }
    );

    if (userResponse.data.errors || !userResponse.data.data.users.length) {
      console.error('Error fetching streamer or streamer not found:', userResponse.data.errors);
      return {};
    }
    const userId = userResponse.data.data.users[0].id;

    // Fetch streamer's emote list with URLs
    const fetchEmotesQuery = `
      query GetUserEmotes($id: ObjectID!) {
        user(id: $id) {
          emote_sets {
            emotes {
              id
              name
              data {
                host {
                  url
                }
                name
              }
            }
          }
        }
      }
    `;
    const emotesResponse = await axios.post(
      'https://7tv.io/v3/gql',
      {
        query: fetchEmotesQuery,
        variables: { id: userId }
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    if (emotesResponse.data.errors) {
      console.error('GraphQL Errors:', emotesResponse.data.errors);
      return {};
    }

    const userData = emotesResponse.data.data.user;
    const emoteMap = {};
    if (userData && userData.emote_sets) {
      userData.emote_sets.forEach(set => {
        set.emotes.forEach(emote => {
          if (emote.data && emote.data.host && emote.data.host.url) {
            const name = emote.name.toLowerCase();
            emoteMap[name] = `${emote.data.host.url}/4x.webp`;
          }
        });
      });
    }

    // Fetch and merge global emotes
    const globalEmotes = await getGlobal7TVEmotes();
    // Merge global emotes, but don't overwrite streamer emotes
    for (const [name, url] of Object.entries(globalEmotes)) {
      if (!(name in emoteMap)) {
        emoteMap[name] = url;
      }
    }

    return emoteMap;
  } catch (error) {
    console.error('Error fetching streamer emote list:', error);
    return {};
  }
}

// -----------------------------------------------------------------------------
// EVENT SUB IMPLEMENTATION (Replacing PubSub)
// -----------------------------------------------------------------------------
async function startEventSubListener() {
  try {
    console.log('[EventSub] Initializing EventSub listener...');

    // Create auth provider with your client ID and access token
    const authProvider = new StaticAuthProvider(
      CONFIG.TWITCH.CLIENT_ID,
      CONFIG.TWITCH.STREAMER_ACCESS_TOKEN
    );

    // Create API client
    const apiClient = new ApiClient({ authProvider });

    // Get the broadcaster ID (needed for event subscriptions)
    let broadcasterId;
    try {
      const user = await apiClient.users.getUserByName(CONFIG.TWITCH.CHANNEL);
      if (!user) {
        throw new Error(`Channel ${CONFIG.TWITCH.CHANNEL} not found`);
      }
      broadcasterId = user.id;
      console.log(`[EventSub] Broadcaster ID for ${CONFIG.TWITCH.CHANNEL}: ${broadcasterId}`);
    } catch (error) {
      console.error('[EventSub] Failed to get broadcaster ID:', error);
      return;
    }

    // Create EventSub listener with proper event handlers
    const listener = new EventSubWsListener({
      apiClient,
      logger: {
        minLevel: 'info', // You can change this to 'info' in production
        name: 'eventsub'
      }
    });

    // Add event handlers using the .on() method (proper approach)
    listener.on('websocket-error', (error) => {
      console.error('[EventSub] WebSocket error:', error);
    });

    listener.on('websocket-reconnect', () => {
      console.log('[EventSub] WebSocket reconnected');
    });

    listener.on('error', (error) => {
      console.error('[EventSub] General error:', error);
    });

    // Start the listener
    await listener.start();
    console.log('[EventSub] Listener started');

    try {
      // Subscribe to channel point redemptions
      try {
        await listener.onChannelRedemptionAdd(broadcasterId, (event) => {
          handleEventSubRedemption(event);
        });
        console.log('[EventSub] Successfully subscribed to channel point redemptions using onChannelRedemptionAdd');
      } catch (e) {
        try {
          await listener.subscribeToChannelRewardRedemptionAddEvents(broadcasterId, null, (event) => {
            handleEventSubRedemption(event);
          });
          console.log('[EventSub] Successfully subscribed to channel point redemptions using subscribeToChannelRewardRedemptionAddEvents');
        } catch (e2) {
          await listener.subscribeToChannelRedemptionAddEvents(broadcasterId, (event) => {
            handleEventSubRedemption(event);
          });
          console.log('[EventSub] Successfully subscribed to channel point redemptions using subscribeToChannelRedemptionAddEvents');
        }
      }
    } catch (error) {
      // Check if the error is because we've already subscribed
      if (error.message?.includes('Too Many Requests') || error.message?.includes('maximum subscriptions')) {
        console.log('[EventSub] Already subscribed to channel point redemptions, continuing...');

        // Even if we can't create a new subscription, we should still receive events
        // for existing subscriptions with the same credentials
      } else {
        console.error('[EventSub] Failed to subscribe to channel redemptions:', error);
      }
    }

    return listener;
  } catch (error) {
    console.error('[EventSub] Error setting up EventSub:', error);
    // Try to reconnect after a delay
    setTimeout(() => {
      startEventSubListener();
    }, 10000);
  }
}

function handleEventSubRedemption(event) {
  try {
    console.log(`[EventSub] Reward redeemed: ${event.rewardTitle} by ${event.userDisplayName}`);

    // Format the redemption in the structure expected by our handlers
    const redemption = {
      reward: {
        id: event.rewardId,
        title: event.rewardTitle
      },
      user: {
        id: event.userId,
        login: event.userName.toLowerCase(),
        display_name: event.userDisplayName
      },
      user_input: event.input || ''
    };

    // Map the reward ID to the appropriate handler
    if (event.rewardId === CONFIG.TWITCH.DUEL_REWARD) {
      handleDuelReward(redemption);
    } else if (event.rewardId === CONFIG.TWITCH.CONE_REWARD) {
      handleConeReward(redemption);
    } else if (event.rewardId === CONFIG.TWITCH.UNBOX_CONE) {
      handleUnboxConeReward(redemption);
    } else if (event.rewardId === CONFIG.TWITCH.BUY_CONE) {
      handleBuyConeReward(redemption);
    } else {
      console.log('[EventSub] Unrecognized reward id:', event.rewardId);
    }
  } catch (error) {
    console.error('[EventSub] Error handling redemption event:', error);
  }
}

// -----------------------------------------------------------------------------
// REWARD HANDLERS (Unchanged, used by both PubSub and EventSub)
// -----------------------------------------------------------------------------
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
    socket.on('unboxfinished', (message) => sendChatMessage(CONFIG.TWITCH.CHANNEL, message));
  } catch (err) {
    console.error('Socket connection error:', err);
  }
});

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
    await LeaderboardManager.db.backup(path.join(backupDir, 'leaderboard.db'));
    await SkinsManager.db.backup(path.join(backupDir, 'skins.db'));
    console.log('Database backup completed.');
    LeaderboardManager.initialize();
    await SkinsManager.initialize();
    server.listen(CONFIG.PORT, () => {
      console.log(`Server is running on port ${CONFIG.PORT}`);
    });
    // Start EventSub listener instead of PubSub
    await startEventSubListener();
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