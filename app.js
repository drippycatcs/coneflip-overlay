const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const Database = require('better-sqlite3');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

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
    CACHE_DURATION: 5000,
};

const errorHandler = (err, req, res, next) => {
    console.error('Error:', err);
    res
        .status(err.status || 500)
        .json({ error: err.message || 'Internal Server Error' });
};

app.use(express.static(CONFIG.PATHS.PUBLIC));
app.use(errorHandler);

app.get('/', (req, res) => {
    /// Just to be sure
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(CONFIG.PATHS.PUBLIC, 'index.html'));
});

app.get('/leaderboard', (req, res) => {
    res.sendFile(path.join(CONFIG.PATHS.PUBLIC, 'leaderboard.html'));
});

app.get('/api/cones/add', (req, res) => {
    const name = req.query.name?.toLowerCase().trim() || '';
    if (!name) return res.status(400).send('Name cannot be blank or invalid.');
    io.emit('addCone', name);
    res.sendStatus(200);
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
            if (data.hasPlayed)
                result = `${name} cone stats: ${data.rank} (Ws: ${data.wins} / Ls: ${data.fails} / WR%: ${data.winrate.toFixed(
                    2
                )})`;
            else result = `${name} never tried coneflipping.`;
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

app.get('/api/skins/set', async (req, res, next) => {
    const name = req.query.name?.toLowerCase().trim() || '';
    const skin = req.query.skin?.toLowerCase().trim() || '';
    const random = req.query.random === 'true';

    if (!name) return res.status(400).json('Name must be provided.');

    try {
        let result;

        if (random) {
            result = await SkinsManager.setRandomSkin(name);
        } else {
            if (!skin) {
                return res
                    .status(400)
                    .json({ error: 'Skin must be provided when random is false.' });
            }
            result = await SkinsManager.setSkin(name, skin);
        }

        res.send(result);
        io.emit('skinRefresh');
    } catch (err) {
        err.status = err.message.includes('Invalid skin') ? 400 : 500;
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
                winrate REAL NOT NULL DEFAULT 0.0
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
            if (b.wins !== a.wins) return b.wins - a.wins; // We sort by descending wins
            if (a.wins > 0) return b.winrate - a.winrate; // Then by winrate
            if (a.fails !== b.fails) return a.fails - b.fails; // After we sort by ascending fails
            return a.name.localeCompare(b.name); // Finally we do alphabetical
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
            const winrate = ((wins / (totalGames)) * 100).toFixed(2);

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
                skin TEXT NOT NULL
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

        this.db
            .prepare('INSERT OR REPLACE INTO user_skins (name, skin) VALUES (?, ?)')
            .run(name, skin);

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
                await this.setSkin(name, skin.name);
                const odds = ((skin.unboxWeight / totalWeight) * 100).toFixed(1);
                return `${name} unboxed "${skin.name}" skin (${odds}%).`;
            }
        }
    }

    static calculateSkinOdds() {
        const skinsAvailableToUnbox = this.getSkinsAvailableToUnbox();
        const totalWeight = skinsAvailableToUnbox.reduce((sum, skin) => sum + skin.unboxWeight, 0);
        return skinsAvailableToUnbox
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
