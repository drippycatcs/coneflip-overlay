

const fs = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');

const CONFIG = {
    PATHS: {
        DATA: path.join(__dirname, 'data'),
        LEADERBOARD: path.join(__dirname, 'data', 'leaderboard.json'),
        SKINS_DATA: path.join(__dirname, 'data', 'skins.json'),
        LEADERBOARD_DB: path.join(__dirname, 'data', 'leaderboard.db'),
        SKINS_DB: path.join(__dirname, 'data', 'skins.db'),
        SKINS_CONFIG: path.join(__dirname, 'public', 'skins', 'config.json'),
    },
};

(async function migrateData() {
    try {
        const leaderboardDb = new Database(CONFIG.PATHS.LEADERBOARD_DB);
        const skinsDb = new Database(CONFIG.PATHS.SKINS_DB);


        leaderboardDb.prepare(
            `CREATE TABLE IF NOT EXISTS leaderboard (
                name TEXT PRIMARY KEY,
                wins INTEGER NOT NULL DEFAULT 0,
                fails INTEGER NOT NULL DEFAULT 0,
                winrate REAL NOT NULL DEFAULT 0.0
            )`
        ).run();


        skinsDb.prepare(
            `CREATE TABLE IF NOT EXISTS skins (
                name TEXT PRIMARY KEY,
                visuals TEXT NOT NULL,
                canUnbox BOOLEAN NOT NULL DEFAULT 0,
                unboxWeight REAL DEFAULT 0
            )`
        ).run();

        skinsDb.prepare(
            `CREATE TABLE IF NOT EXISTS user_skins (
                name TEXT PRIMARY KEY,
                skin TEXT NOT NULL
            )`
        ).run();


        try {
            const skinsConfigData = await fs.readFile(CONFIG.PATHS.SKINS_CONFIG, 'utf8');
            const skinsConfig = JSON.parse(skinsConfigData);

            const insertSkinsStmt = skinsDb.prepare(
                'INSERT OR REPLACE INTO skins (name, visuals, canUnbox, unboxWeight) VALUES (?, ?, ?, ?)'
            );

            const insertManySkins = skinsDb.transaction((skins) => {
                for (const skin of skins) {
                    insertSkinsStmt.run(
                        skin.name,
                        skin.visuals,
                        skin.canUnbox ? 1 : 0,
                        skin.unboxWeight || 0
                    );
                }
            });

            insertManySkins(skinsConfig);
            console.log('Skins data imported successfully.');
        } catch (err) {
            console.error('Failed to import skins data:', err.message);
        }


        try {
            const leaderboardDataRaw = await fs.readFile(CONFIG.PATHS.LEADERBOARD, 'utf8');
            const leaderboardData = JSON.parse(leaderboardDataRaw);

            const insertLeaderboardStmt = leaderboardDb.prepare(
                'INSERT OR REPLACE INTO leaderboard (name, wins, fails, winrate) VALUES (?, ?, ?, ?)'
            );

            const insertManyLeaderboard = leaderboardDb.transaction((data) => {
                for (const player of data) {
                    insertLeaderboardStmt.run(
                        player.name,
                        player.wins,
                        player.fails,
                        parseFloat(player.winrate)
                    );
                }
            });

            insertManyLeaderboard(leaderboardData);
            console.log('Leaderboard data imported successfully.');
        } catch (err) {
            console.error('Failed to import leaderboard data:', err.message);
        }


        try {
            const userSkinsDataRaw = await fs.readFile(CONFIG.PATHS.SKINS_DATA, 'utf8');
            const userSkinsData = JSON.parse(userSkinsDataRaw);

            const insertUserSkinsStmt = skinsDb.prepare(
                'INSERT OR REPLACE INTO user_skins (name, skin) VALUES (?, ?)'
            );

            const insertManyUserSkins = skinsDb.transaction((data) => {
                for (const user of data) {
                    insertUserSkinsStmt.run(user.name, user.skin);
                }
            });

            insertManyUserSkins(userSkinsData);
            console.log('User skins data imported successfully.');
        } catch (err) {
            console.error('Failed to import user skins data:', err.message);
        }

        leaderboardDb.close();
        skinsDb.close();
        console.log('Data migration completed.');
    } catch (err) {
        console.error('An error occurred during data migration:', err.message);
    }
})();
