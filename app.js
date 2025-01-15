const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const Database = require('better-sqlite3');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const axios = require('axios');
require('dotenv').config();

/**
 * @typedef {{name: string, visuals: string, canUnbox: boolean, unboxWeight?: number}} Skin
 */

/**
 * `canUnbox === true`
 *
 * `unboxWeight !== undefined`
 * @typedef {{name: string, visuals: string, canUnbox: boolean, unboxWeight: number}} AvailableToUnboxSkin
 */

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
        ACCESS_TOKEN: process.env.TWITCH_ACCESS_TOKEN,
    },
    CACHE_DURATION: 5000,
};

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

// app.get('/api/cones/duel', (req, res) => {
//     const name = req.query.name?.toLowerCase().trim() || '';
//     const name2 = req.query.duel?.toLowerCase().trim() || '';
//     if (!name) return res.send('Name cannot be blank or invalid.');
//     io.emit('addCone', name);
//     io.emit('addCone', name2);
//     res.sendStatus(200);
// });

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

app.get('/api/leaderboard/average', async (req, res, next) => {
    try {
        const data = await LeaderboardManager.calculateLbStats();
        res.send(
            `${data.totalGamesPlayed} cones have been redeemed by ${data.playerCount} players with an average winrate of ${data.averageWinRate}%!`
        );
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

app.get('/api/skins/inventory', async (req, res, next) => {
    const name = req.query.name?.toLowerCase().trim() || '';
    if (!name) return res.send('Name must be provided.');

    try {
        const stmt = SkinsManager.db.prepare('SELECT * FROM user_skins WHERE name = ?');
        const user = stmt.get(name);

        if (!user) return res.send(`${name} doesn't have any skins.`);

        res.status(200).send(`${name} owns the following skins: ${user.inventory.split(',').join(', ')}, default. | Currently selected: ${user.skin}`);
    } catch (err) {
        next(err);
    }
});

app.get('/api/skins/set', async (req, res, next) => {
    const name = req.query.name?.toLowerCase().trim() || '';
    const skin = req.query.skin?.toLowerCase().trim() || '';
    const random = req.query.random === 'true';

    if (!name) return res.send('Name must be provided.');

    try {
        let result;

        if (random) {
            result = await SkinsManager.setRandomSkin(name);
        } else {
            if (!skin) return res.send('Skin must be provided.');
            result = await SkinsManager.setSkin(name, skin);
        }

        res.send(result);
        io.emit('skinRefresh');
    } catch (err) {
        next(err);
    }
});

app.get('/api/skins/swapskin', async (req, res, next) => {
    const name = req.query.name?.toLowerCase().trim() || '';
    const skin = req.query.skin?.toLowerCase().trim() || '';

    if (!name) return res.send('Name must be provided.');
    if (!skin) return res.send('Skin must be provided.');

    try {
        const stmt = SkinsManager.db.prepare('SELECT inventory, skin FROM user_skins WHERE name = ?');
        const user = stmt.get(name);

        if (!user) return res.send(`${name} doesn't have any skins.`);

        const inventory = user.inventory ? user.inventory.split(',') : [];

        if (inventory.includes(skin) || skin === 'default') {
            SkinsManager.db
                .prepare('UPDATE user_skins SET skin = ? WHERE name = ?')
                .run(skin, name);

            io.emit('skinRefresh');
            return res.send(`Swapped ${name}'s skin to ${skin}`);
        } else {
            return res.send(`${name} doesn't own this skin WeirdChamp`)
        }
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

app.get('/api/skins/odds', (req, res, next) => {
    try {
        res.send(SkinsManager.calculateSkinOdds());
    } catch (err) {
        next(err);
    }
});

async function getTwitchId(username) {
    try {
        const response = await axios.get(CONFIG.TWITCH.API, {
            headers: {
                'Client-ID': CONFIG.TWITCH.CLIENT_ID,
                'Authorization': `Bearer ${CONFIG.TWITCH.ACCESS_TOKEN}`,
            },
            params: {
                login: username,
            },
        });

        const user = response.data.data[0];
        if (user) {
            return user.id;
        } else {
            return null;
        }
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

        const averageWinRate =
            playerCount > 0 ? (totalWinRate / playerCount).toFixed(2) : '0.00';

        return { averageWinRate, totalGamesPlayed, playerCount };
    }

    static async getPlayer(name) {
        const data = await this.getLeaderboard();
        const index = data.findIndex((r) => r.name === name);
        if (index === -1) return { hasPlayed: false };

        const player = data[index];
        const rank = `${index + 1}/${data.length}`;

        return {
            hasPlayed: true,
            rank: rank,
            wins: player.wins,
            fails: player.fails,
            winrate: player.winrate,
        };
    }

    static async updatePlayer(name, isWin) {
        const stmtGet = this.db.prepare('SELECT * FROM leaderboard WHERE name = ?');
        const player = stmtGet.get(name);

        if (player) {
            const wins = isWin ? player.wins + 1 : player.wins;
            const fails = isWin ? player.fails : player.fails + 1;
            const totalGames = wins + fails;
            const winrate = ((wins / totalGames) * 100).toFixed(2);

            this.db
                .prepare('UPDATE leaderboard SET wins = ?, fails = ?, winrate = ? WHERE name = ?')
                .run(wins, fails, winrate, name);
        } else {
            const wins = isWin ? 1 : 0;
            const fails = isWin ? 0 : 1;
            const totalGames = wins + fails;
            const winrate = ((wins / totalGames) * 100).toFixed(2);

            this.db
                .prepare('INSERT INTO leaderboard (name, wins, fails, winrate) VALUES (?, ?, ?, ?)')
                .run(name, wins, fails, winrate);
        }

        return this.getLeaderboard();
    }
}

class SkinsManager {
    /**
     *  @type {Object.<string, Skin>}
     */
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

        const insertStmt = this.db.prepare(
            'INSERT OR REPLACE INTO skins (name, visuals, canUnbox, unboxWeight) VALUES (?, ?, ?, ?)'
        );

        const insertMany = this.db.transaction((skins) => {
            for (const skin of skins) {
                insertStmt.run(
                    skin.name,
                    skin.visuals,
                    skin.canUnbox ? 1 : 0,
                    skin.unboxWeight || 0
                );
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

        let inventory = [];

        if (user) {
            inventory = user.inventory ? user.inventory.split(',') : [];
        }

        if (!inventory.includes(skin)) {
            inventory.push(skin);
        }

        const updatedInventory = inventory.join(',');

        if (user) {
            this.db
                .prepare('UPDATE user_skins SET inventory = ?, skin = ? WHERE name = ?')
                .run(updatedInventory, skin, name);
        } else {
            const twitchid = await getTwitchId(name);
            this.db
                .prepare('INSERT INTO user_skins (name, skin, inventory, twitchid) VALUES (?, ?, ?, ?)')
                .run(name, skin, updatedInventory, twitchid);
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

                let inventory = [];

                if (user) {
                    inventory = user.inventory
                        ? user.inventory.split(',').map(skin => skin.trim())
                        : [];
                }



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
            .map(
                (skin) => `${skin.name} (${((skin.unboxWeight / totalWeight) * 100).toFixed(1)}%)`
            )
            .join(', ');
    }

    /**
     * @return {[AvailableToUnboxSkin]}
     */
    static getSkinsAvailableToUnbox() {
        return Object.values(this.availableSkins).filter((skin) => skin.canUnbox);
    }
}

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

async function startServer() {
    try {
        await Promise.all([LeaderboardManager.initialize(), SkinsManager.initialize()]);

        http.listen(CONFIG.PORT, () => {
            console.log(`Server is running on port ${CONFIG.PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

startServer();
