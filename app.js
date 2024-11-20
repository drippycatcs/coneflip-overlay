const express = require('express');
const path = require('path');
const fs = require('fs');
const sanitize = require('sanitize-filename'); // For sanitizing input
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const PORT = process.env.PORT || 3000;
const LEADERBOARD_JSON = path.join(__dirname, 'leaderboard.json');
const SKINS_JSON = path.join(__dirname, 'skins.json');

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/skins.json', (req, res) => {
    res.sendFile(SKINS_JSON);
});

app.get('/leaderboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});

app.get('/addcone', (req, res) => {
    const name = sanitize(req.query.name || '').trim();
    if (!name) {
        return res.status(400).send('Name cannot be blank or invalid.');
    }
    io.emit('addCone', name);
    res.sendStatus(200);
});

if (!fs.existsSync(LEADERBOARD_JSON)) {
    fs.writeFileSync(LEADERBOARD_JSON, JSON.stringify([]), 'utf8');
}

function readLeaderboard() {
    return new Promise((resolve, reject) => {
        fs.readFile(LEADERBOARD_JSON, 'utf8', (err, data) => {
            if (err) return reject(err);
            try {
                const leaderboard = JSON.parse(data);
                resolve(leaderboard);
            } catch (parseErr) {
                reject(parseErr);
            }
        });
    });
}

function writeLeaderboard(data) {
    return new Promise((resolve, reject) => {
        fs.writeFile(LEADERBOARD_JSON, JSON.stringify(data, null, 2), 'utf8', (err) => {
            if (err) return reject(err);
            const sortedData = [...data].sort((a, b) => b.wins - a.wins);
            const highestWins = sortedData[0].wins;
            const topPlayer = sortedData.filter(player => player.wins === highestWins)[0]?.name || null;
            resolve(topPlayer);
        });
    });
}

app.get('/api/leaderboard', async (req, res) => {
    try {
        const data = await readLeaderboard();
        if (data.length === 0) return res.json({ leaderboard: data, topPlayer: null });
        const sortedData = [...data].sort((a, b) => b.wins - a.wins);
        const highestWins = sortedData[0].wins;
        const topPlayer = sortedData.filter(player => player.wins === highestWins)[0]?.name || null;
        res.json({ leaderboard: data, topPlayer: topPlayer });
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/leaderboard/:name', async (req, res) => {
    try {
        const data = await readLeaderboard();

        const sortedData = [...data].sort((a, b) => b.wins - a.wins);
        const rank = sortedData.findIndex((r) => r.name.toLowerCase() === req.params.name) + 1;

        if (!rank) {
            res.send(`you did no coneflips.`);
            return;
        }

        res.send(`Your coneflip rank: ${rank}/${sortedData.length} (Ws: ${sortedData[rank - 1].wins} / Ls: ${sortedData[rank - 1].fails} / WR%: ${sortedData[rank - 1].winrate})`);
    } catch (err) {
        console.error('Error fetching player record:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Add a skin to a user
app.get('/addSkin', (req, res) => {
    const name = sanitize(req.query.name || '').trim().toLowerCase();
    const skin = sanitize(req.query.skin || '').trim().toLowerCase();

    if (!name || !skin) {
        return res.status(400).send('Name and skin must be provided.');
    }

    // Reject if the skin is "gold"
    if (skin === "gold") {
        return res.status(400).send('Don\'t give yourself gold bozo');
    }

    fs.readFile(SKINS_JSON, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Error reading skins file.');
        }

        let skins = [];
        try {
            skins = JSON.parse(data);
        } catch (err) {
            return res.status(500).send('Error parsing skins file.');
        }

        // Check if user already has a skin entry
        const existingSkin = skins.find(user => user.name === name);

        if (existingSkin) {
            existingSkin.skin = skin; // Update existing skin
        } else {
            skins.push({ name: name, skin: skin }); // Add new skin
        }

        fs.writeFile(SKINS_JSON, JSON.stringify(skins, null, 2), 'utf8', (err) => {
            if (err) {
                return res.status(500).send('Error writing to skins file.');
            }
            res.send(`Skin for ${name} updated to ${skin}`);
        });
    });
});


io.on('connection', (socket) => {
    readLeaderboard()
        .then((data) => {
            if (data.length === 0) {
                socket.emit('leaderboard', { leaderboard: data, topPlayer: null });
                return;
            }
            const sortedData = [...data].sort((a, b) => b.wins - a.wins);
            const highestWins = sortedData[0].wins;
            const topPlayer = sortedData.filter(player => player.wins === highestWins)[0]?.name || null;
            socket.emit('leaderboard', { leaderboard: data, topPlayer: topPlayer });
        });

    socket.on('win', (winnerName) => {
        const safeName = sanitize(winnerName.trim());
        if (!safeName) return;

        readLeaderboard()
            .then((data) => {
                let winner = data.find(entry => entry.name === safeName);
                if (winner) {
                    winner.wins += 1;
                } else {
                    data.push({ name: safeName, wins: 1, fails: 0, winrate: '100.00' });
                }

                data.forEach(entry => {
                    const total = entry.wins + entry.fails;
                    entry.winrate = total > 0 ? ((entry.wins / total) * 100).toFixed(2) : '0.00';
                });

                return writeLeaderboard(data);
            })
            .then((topPlayer) => {
                readLeaderboard().then((updatedData) => {
                    io.emit('leaderboard', { leaderboard: updatedData, topPlayer: topPlayer });
                });
            });
    });

    socket.on('fail', (failedName) => {
        const safeName = sanitize(failedName.trim());
        if (!safeName) return;

        readLeaderboard()
            .then((data) => {
                let failedUser = data.find(entry => entry.name === safeName);
                if (failedUser) {
                    failedUser.fails += 1;
                } else {
                    data.push({ name: safeName, wins: 0, fails: 1, winrate: '0.00' });
                }

                data.forEach(entry => {
                    const total = entry.wins + entry.fails;
                    entry.winrate = total > 0 ? ((entry.wins / total) * 100).toFixed(2) : '0.00';
                });

                return writeLeaderboard(data);
            })
            .then((topPlayer) => {
                readLeaderboard().then((updatedData) => {
                    io.emit('leaderboard', { leaderboard: updatedData, topPlayer: topPlayer });
                });
            });
    });
});

http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

/*
 _._     _,-'""`-._
(,-.`._,'(       |\`-/|
    `-.-' \ )-`( , o o)
          `-    \`_`"'- 
*/
