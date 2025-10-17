const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active sessions (in production, use Redis)
const activeSessions = new Map();

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to start authentication
app.post('/api/start-auth', async (req, res) => {
    const { phone, apiId, apiHash } = req.body;
    
    if (!phone || !apiId || !apiHash) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const sessionId = crypto.randomBytes(16).toString('hex');
        const stringSession = new StringSession('');
        
        const client = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
            connectionRetries: 5,
        });

        await client.connect();
        const codeRequest = await client.sendCode(phone, {
            apiId: parseInt(apiId),
            apiHash: apiHash,
        });

        // Store temporary session data
        activeSessions.set(sessionId, {
            client,
            phone,
            apiId,
            apiHash,
            phoneCodeHash: codeRequest.phoneCodeHash
        });

        res.json({ 
            success: true, 
            sessionId,
            message: 'Verification code sent to your Telegram account'
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Failed to send verification code: ' + error.message });
    }
});

// API endpoint to verify code and start userbot
app.post('/api/verify-code', async (req, res) => {
    const { sessionId, code } = req.body;
    
    if (!sessionId || !code) {
        return res.status(400).json({ error: 'Missing session ID or code' });
    }

    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }

    try {
        const { client, phone, phoneCodeHash } = sessionData;
        
        // Sign in with the code
        await client.signIn(phone, code, phoneCodeHash);
        
        // Start the userbot functionality
        startUserBot(client, sessionId);
        
        // Store the active session
        activeSessions.set(sessionId, {
            ...sessionData,
            isConnected: true,
            connectedAt: new Date()
        });

        res.json({ 
            success: true, 
            message: 'Successfully connected! Your userbot is now running.' 
        });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ error: 'Failed to verify code: ' + error.message });
    }
});

// UserBot functionality
function startUserBot(client, sessionId) {
    console.log(`Starting userbot for session: ${sessionId}`);
    
    // Handle new messages
    client.addEventHandler(async (event) => {
        const message = event.message;
        
        if (message.text && message.text.startsWith('/')) {
            console.log(`Received command: ${message.text}`);
            
            // Handle /menu command
            if (message.text === '/menu') {
                await client.sendMessage(message.chatId, {
                    message: `🤖 **UserBot Connected!**\n\n` +
                            `✅ Status: Active\n` +
                            `🔗 Session: ${sessionId.substring(0, 8)}...\n` +
                            `⏰ Connected: ${new Date().toLocaleString()}\n\n` +
                            `Available commands:\n` +
                            `/menu - Show this menu\n` +
                            `/ping - Check responsiveness\n` +
                            `/status - Bot status`
                });
            }
            
            // Handle /ping command
            if (message.text === '/ping') {
                const start = Date.now();
                await client.sendMessage(message.chatId, {
                    message: '🏓 Pong!'
                });
                const latency = Date.now() - start;
                await client.sendMessage(message.chatId, {
                    message: `⏱️ Response time: ${latency}ms`
                });
            }
            
            // Handle /status command
            if (message.text === '/status') {
                await client.sendMessage(message.chatId, {
                    message: `📊 **Bot Status**\n\n` +
                            `🟢 Online\n` +
                            `💾 Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB\n` +
                            `🕐 Uptime: ${Math.floor(process.uptime() / 60)} minutes\n` +
                            `🔗 Host: Render Web Service`
                });
            }
        }
    });

    // Set bot status
    client.setUpdateHandler(async (update) => {
        // Handle different types of updates
        console.log('Update received:', update.className);
    });

    console.log(`Userbot started successfully for session: ${sessionId}`);
}

// Socket.io for real-time updates
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// Cleanup function
function cleanupSessions() {
    const now = Date.now();
    for (const [sessionId, sessionData] of activeSessions.entries()) {
        if (sessionData.connectedAt && (now - sessionData.connectedAt > 24 * 60 * 60 * 1000)) {
            // Session older than 24 hours
            if (sessionData.client) {
                sessionData.client.disconnect();
            }
            activeSessions.delete(sessionId);
            console.log(`Cleaned up session: ${sessionId}`);
        }
    }
}

// Cleanup every hour
setInterval(cleanupSessions, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit: http://localhost:${PORT}`);
});