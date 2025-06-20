require('dotenv').config();
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const axios = require('axios');
const tmi = require('tmi.js');

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const STREAMER_ACCESS_TOKEN = process.env.STREAMER_ACCESS_TOKEN;
const BOT_ACCESS_TOKEN = process.env.BOT_ACCESS_TOKEN;
const USER_ID = '782127507'; //replace with your Twitch user ID
const DB_PATH = './data/leaderboard.db';
const WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const API_URL = 'http://localhost:3000/api/cones/add';
const CHANNEL_NAME = process.env.TWITCH_CHANNEL;
const BOT_NAME = process.env.BOT_NAME;

const db = new Database(DB_PATH, { verbose: console.log });
const ws = new WebSocket(WS_URL);

const chatClient = new tmi.Client({
    options: { debug: false },
    identity: {
        username: BOT_NAME,
        password: `oauth:${BOT_ACCESS_TOKEN}`
    },
    channels: [CHANNEL_NAME]
});

chatClient.connect().catch(console.error);

ws.on('open', () => {
    console.log('Connected to Twitch EventSub WebSocket.');
});

ws.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.metadata && message.metadata.message_type === 'session_welcome') {
        console.log('Session started. Subscribing to follow events...');
        subscribeToFollowEvents(message.payload.session.id);
    }

    if (message.metadata && message.metadata.message_type === 'notification') {
        const event = message.payload.event;
        if (event && event.user_name) {
            console.log(`👥 New follower: ${event.user_name} (${event.user_login})`);
            checkFollowerInLeaderboard(event.user_name);
        }
    }
});

ws.on('error', (err) => {
    console.error('WebSocket error:', err);
});

ws.on('close', () => {
    console.log('Connection closed.');
});

function subscribeToFollowEvents(sessionId) {
    fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
            'Client-ID': CLIENT_ID,
            'Authorization': `Bearer ${STREAMER_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            type: 'channel.follow',
            version: '2',
            condition: { broadcaster_user_id: USER_ID, moderator_user_id: USER_ID },
            transport: { method: 'websocket', session_id: sessionId }
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            console.error('Subscription error:', data);
        } else {
            console.log('Successfully subscribed to follow events.');
        }
    })
    .catch(err => console.error('Fetch error:', err));
}

function checkFollowerInLeaderboard(username) {
    try {
        const stmt = db.prepare('SELECT * FROM leaderboard WHERE name = ?');
        const user = stmt.get(username);
        
        if (user) {
            console.log(`New follower ${username} already exists in leaderboard: Rank ${user.rank}, Wins: ${user.wins}, Losses: ${user.fails}, Winrate: ${user.winrate.toFixed(2)}%`);
        } else {
            console.log(`New follower ${username} does not exist in the leaderboard.`);
            
            // Check if streamer is live before adding to leaderboard and sending message
            checkStreamerStatusAndHandleFollower(username);
        }
    } catch (error) {
        console.error('Error checking leaderboard:', error);
    }
}

async function checkStreamerStatusAndHandleFollower(username) {
    try {
        const response = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${USER_ID}`, {
            headers: {
                'Client-ID': CLIENT_ID,
                'Authorization': `Bearer ${STREAMER_ACCESS_TOKEN}`
            }
        });

        const streamData = response.data.data[0];
        const isLive = !!streamData;

        if (isLive) {
            console.log(`🎬 Streamer is LIVE! Adding ${username} to leaderboard and sending welcome message.`);
            
            // Add to leaderboard and send welcome message
            axios.get(`${API_URL}?name=${encodeURIComponent(username)}`)
                .then(() => {
                    sendChatMessage(username);
                })
                .catch(error => {
                    console.error(`Error adding ${username} to leaderboard:`, error.message);
                });
        } else {
            console.log(`🔴 Streamer is OFFLINE. Not adding ${username} to leaderboard.`);
            
            // Don't add to leaderboard when offline
        }
    } catch (error) {
        console.error('Error checking streamer status:', error.message);
        
        // If we can't check status, still add to leaderboard but don't send message
        axios.get(`${API_URL}?name=${encodeURIComponent(username)}`)
            .catch(error => {
                console.error(`Error adding ${username} to leaderboard:`, error.message);
            });
    }
}

function sendChatMessage(username) {
    if (chatClient) {
        chatClient.say(CHANNEL_NAME, `@${username} Welcome to the channel! Enjoy your free coneflip! 🎉`)
            .catch(console.error);
    } else {
        console.error('Chat client not connected.');
    }
}
