const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const CONFIG = {
    PORT: process.env.PORT || 3000,
    PATHS: {
        LEADERBOARD: path.join(__dirname, 'data', 'leaderboard.json'),
        SKINS: path.join(__dirname, 'data', 'skins.json'),
        PUBLIC: path.join(__dirname, 'public')
    },
    CACHE_DURATION: 5000,
    VALID_SKINS: [
        'glorp',
        'casehardened',
        'inverted',
        'negative',
        'ahegao',
        'fade',
        'tigertooth'
    ]
};

let lbCache = null;
let lastLbUpdate = 0;

app.use(express.static(CONFIG.PATHS.PUBLIC));

app.get('/', (req, res) => {
    res.sendFile(path.join(CONFIG.PATHS.PUBLIC, 'index.html'));
});

app.get('/leaderboard.html', (req, res) => {
    res.sendFile(path.join(CONFIG.PATHS.PUBLIC, 'leaderboard.html'));
});

app.get('/skins.json', (req, res) => {
    res.sendFile(CONFIG.PATHS.SKINS);
});

app.get('/addcone', (req, res) => {
    const name = req.query.name.toLocaleLowerCase().trim() || '';
    if (!name) return res.status(400).send('Name cannot be blank or invalid.');
    io.emit('addCone', name);
    res.sendStatus(200);
});

app.get('/setskin', async (req, res) => {
    const name = req.query.name.toLocaleLowerCase().trim() || '';
    const skin = req.query.skin.toLocaleLowerCase().trim() || '';

    if (!name || !skin) return res.status(400).send('Name and skin must be provided.');

    try {
        const result = await SkinsManager.setSkin(name, skin);
        res.send(result);
    } catch (err) {
        const statusCode = err.message.includes('Invalid skin') ? 400 : 500;
        res.status(statusCode).send(err.message);
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const data = await LeaderboardManager.getLeaderboard();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/leaderboard/:name', async (req, res) => {
    try {
        const data = await LeaderboardManager.getLeaderboard();
        const rank = data.findIndex((r) => r.name.toLowerCase() === req.params.name.toLowerCase()) + 1;

        if (!rank) return res.send('did no coneflips.');

        const player = data[rank - 1];
        res.send(`coneflip rank: ${rank}/${data.length} (Ws: ${player.wins} / Ls: ${player.fails} / WR%: ${player.winrate})`);
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

class LeaderboardManager {
    static async initialize() {
        try {
            await fs.access(CONFIG.PATHS.LEADERBOARD);
        } catch {
            await fs.writeFile(CONFIG.PATHS.LEADERBOARD, JSON.stringify([]), 'utf8');
        }
    }

    static async getLeaderboard() {
        const now = Date.now();
        if (lbCache && (now - lastLbUpdate < CONFIG.CACHE_DURATION)) return lbCache;

        const data = await fs.readFile(CONFIG.PATHS.LEADERBOARD, 'utf8');
        lbCache = JSON.parse(data);
        lastLbUpdate = now;
        return lbCache;
    }

    static async updateLeaderboard(data) {
        const sortedData = this.sortLeaderboard(data);
        await fs.writeFile(CONFIG.PATHS.LEADERBOARD, JSON.stringify(sortedData, null, 2), 'utf8');
        lbCache = sortedData;
        lastLbUpdate = Date.now();
        return lbCache;
    }

    static async updatePlayer(playerName, isWin) {
        const data = await this.getLeaderboard();
        const player = data.find(entry => entry.name === playerName);

        if (player) {
            if (isWin) {
                player.wins += 1;
            } else {
                player.fails += 1;
            }
            player.winrate = ((player.wins / (player.wins + player.fails)) * 100).toFixed(2);
        } else {
            data.push({
                name: playerName,
                wins: isWin ? 1 : 0,
                fails: isWin ? 0 : 1,
                winrate: isWin ? '100.00' : '0.00'
            });
        }

        const newData = await this.updateLeaderboard(data);
        return { topPlayer: newData[0].name || null };
    }

    static sortLeaderboard(data) {
        const sorted = data.sort((a, b) => {
            if (b.wins !== a.wins) return b.wins - a.wins; // We sort by descending wins
            if (a.wins > 0) return b.winrate - a.winrate; // Then by winrate
            if (a.fails !== b.fails) return a.fails - b.fails; // After we sort by ascending fails
            return a.name.localeCompare(b.name); // Finally we do alphabetical
        });
        return sorted;
    }
}

class SkinsManager {
    static async initialize() {
        try {
            await fs.access(CONFIG.PATHS.SKINS);
        } catch {
            await fs.writeFile(CONFIG.PATHS.SKINS, JSON.stringify([]), 'utf8');
        }
    }

    static isValidSkin(skin) {
        return CONFIG.VALID_SKINS.includes(skin);
    }

    static async setSkin(name, skin) {
        if (!this.isValidSkin(skin)) {
            throw new Error('Invalid skin.');
        }

        const data = await fs.readFile(CONFIG.PATHS.SKINS, 'utf8');
        const skins = JSON.parse(data);

        const existingIndex = skins.findIndex(user => user.name === name);
        if (existingIndex !== -1) {
            skins[existingIndex].skin = skin;
        } else {
            skins.push({ name, skin });
        }

        await fs.writeFile(CONFIG.PATHS.SKINS, JSON.stringify(skins, null, 2), 'utf8');
        return `Skin for ${name} updated to ${skin}`;
    }
}

io.on('connection', async (socket) => {
    try {
        const data = await LeaderboardManager.getLeaderboard();
        
        const topPlayer = data[0]?.name || null;
        socket.emit('goldSkin', { topPlayer: topPlayer });
        socket.emit('leaderboard', { data });

        const updateStateHandler = async (playerName, isWin) => {
            try {
                const result = await LeaderboardManager.updatePlayer(playerName, isWin);
                io.emit('leaderboard', result);
            } catch (err) {
                console.error(`Error updating player state: ${err.message}`);
            }
        };

        socket.on('win', (playerName) => updateStateHandler(playerName, true));
        socket.on('fail', (playerName) => updateStateHandler(playerName, false));

    } catch (err) {
        console.error('Socket connection error:', err);
    }
});

async function startServer() {
    await LeaderboardManager.initialize();
    await SkinsManager.initialize();
    http.listen(CONFIG.PORT, () => {
        console.log(`Server is running on port ${CONFIG.PORT}`);
    });
}

startServer().catch(console.error);