const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const crypto = require('crypto');
const nodeCron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active sessions and clients
const activeSessions = new Map();
const activeClients = new Map();

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to start authentication
app.post('/api/start-auth', async (req, res) => {
    const { phone, apiId, apiHash } = req.body;
    
    console.log('Auth request received for:', phone);
    
    if (!phone || !apiId || !apiHash) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate API ID is a number
    if (isNaN(parseInt(apiId))) {
        return res.status(400).json({ error: 'API ID must be a number' });
    }

    try {
        const sessionId = crypto.randomBytes(16).toString('hex');
        const stringSession = new StringSession('');
        
        console.log('Creating Telegram client for session:', sessionId);
        
        const client = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
            connectionRetries: 5,
        });

        await client.connect();
        console.log('Connected to Telegram, sending code...');
        
        const codeRequest = await client.sendCode(phone, {
            apiId: parseInt(apiId),
            apiHash: apiHash,
        });

        // Store temporary session data
        activeSessions.set(sessionId, {
            client,
            phone,
            apiId: parseInt(apiId),
            apiHash,
            phoneCodeHash: codeRequest.phoneCodeHash,
            createdAt: Date.now()
        });

        console.log('Verification code sent to:', phone);
        
        res.json({ 
            success: true, 
            sessionId,
            message: 'Verification code sent to your Telegram account. Check your Telegram app.'
        });
    } catch (error) {
        console.error('Telegram auth error:', error);
        
        let errorMessage = 'Failed to send verification code: ';
        if (error.message.includes('PHONE_NUMBER_INVALID')) {
            errorMessage = 'Invalid phone number format';
        } else if (error.message.includes('API_ID_INVALID')) {
            errorMessage = 'Invalid API ID or API Hash';
        } else if (error.message.includes('FLOOD')) {
            errorMessage = 'Too many attempts. Please wait before trying again.';
        } else {
            errorMessage += error.message;
        }
        
        res.status(500).json({ error: errorMessage });
    }
});

// API endpoint to verify code and start userbot
app.post('/api/verify-code', async (req, res) => {
    const { sessionId, code, password } = req.body;
    
    console.log('Verification attempt for session:', sessionId);
    
    if (!sessionId || !code) {
        return res.status(400).json({ error: 'Missing session ID or code' });
    }

    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }

    try {
        const { client, phone, phoneCodeHash } = sessionData;
        
        console.log('Signing in with code...');
        
        // Sign in with the code
        try {
            await client.signIn(phone, code, phoneCodeHash);
        } catch (signInError) {
            // If 2FA password is required
            if (signInError.message.includes('SESSION_PASSWORD_NEEDED')) {
                if (!password) {
                    return res.status(400).json({ 
                        error: 'Two-factor authentication required', 
                        requires2FA: true 
                    });
                }
                // For 2FA, you would need to handle the password
                // This is a simplified version
                return res.status(400).json({ 
                    error: '2FA is not fully supported in this version. Please use an account without 2FA.' 
                });
            }
            throw signInError;
        }

        // Get user information
        const me = await client.getMe();
        console.log('Successfully signed in as:', me.username || me.firstName);
        
        // Start the userbot functionality
        await startUserBot(client, sessionId, me);
        
        // Store the active client
        activeClients.set(sessionId, {
            client,
            user: me,
            connectedAt: new Date(),
            sessionString: client.session.save() // Save session for persistence
        });

        // Remove from temporary sessions
        activeSessions.delete(sessionId);

        console.log('Userbot started successfully for:', me.username || me.firstName);
        
        res.json({ 
            success: true, 
            message: `Successfully connected as ${me.firstName || me.username}! Your userbot is now running.`,
            username: me.username,
            firstName: me.firstName,
            sessionId: sessionId
        });
    } catch (error) {
        console.error('Verification error:', error);
        
        let errorMessage = 'Failed to verify code: ';
        if (error.message.includes('PHONE_CODE_INVALID')) {
            errorMessage = 'Invalid verification code';
        } else if (error.message.includes('PHONE_CODE_EXPIRED')) {
            errorMessage = 'Verification code has expired. Please request a new one.';
        } else if (error.message.includes('SESSION_PASSWORD_NEEDED')) {
            errorMessage = 'Two-factor authentication is required for this account';
        } else {
            errorMessage += error.message;
        }
        
        res.status(500).json({ error: errorMessage });
    }
});

// Real UserBot functionality
async function startUserBot(client, sessionId, user) {
    console.log(`Starting real userbot for: ${user.firstName || user.username}`);
    
    // Handle incoming messages
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;
            if (!message || !message.text) return;
            
            const command = message.text.toLowerCase().trim();
            const chatId = message.chatId;
            
            console.log(`Received message: ${command} from chat: ${chatId}`);
            
            // Handle /menu command
            if (command === '/menu') {
                await client.sendMessage(chatId, {
                    message: `🤖 **Telegram UserBot Active!**\n\n` +
                            `👤 User: ${user.firstName || user.username}\n` +
                            `🆔 ID: ${user.id}\n` +
                            `🔗 Session: ${sessionId.substring(0, 8)}...\n` +
                            `⏰ Connected: ${new Date().toLocaleString()}\n` +
                            `🌐 Host: Render Web Service\n\n` +
                            `**Available Commands:**\n` +
                            `/menu - Show this menu\n` +
                            `/ping - Test bot responsiveness\n` +
                            `/status - Detailed bot status\n` +
                            `/chats - List your recent chats\n` +
                            `/info - Get chat information`
                });
            }
            
            // Handle /ping command
            else if (command === '/ping') {
                const start = Date.now();
                const sentMessage = await client.sendMessage(chatId, {
                    message: '🏓 Pong!'
                });
                const latency = Date.now() - start;
                
                await client.editMessage(chatId, {
                    message: sentMessage.id,
                    text: `🏓 Pong!\n⏱️ Response time: ${latency}ms\n💬 Message ID: ${sentMessage.id}`
                });
            }
            
            // Handle /status command
            else if (command === '/status') {
                const memoryUsage = process.memoryUsage();
                const uptime = process.uptime();
                
                await client.sendMessage(chatId, {
                    message: `📊 **Bot Status Report**\n\n` +
                            `🟢 **Status:** Online & Active\n` +
                            `👤 **Logged in as:** ${user.firstName || user.username}\n` +
                            `💾 **Memory Usage:** ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB\n` +
                            `🕐 **Uptime:** ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m\n` +
                            `📅 **Server Time:** ${new Date().toLocaleString()}\n` +
                            `🔗 **Active Sessions:** ${activeClients.size}\n` +
                            `⚡ **Platform:** Node.js ${process.version}`
                });
            }
            
            // Handle /chats command
            else if (command === '/chats') {
                const dialogs = await client.getDialogs({ limit: 10 });
                let chatsList = '💬 **Recent Chats:**\n\n';
                
                dialogs.slice(0, 8).forEach((dialog, index) => {
                    const chat = dialog.entity;
                    const unread = dialog.unreadCount > 0 ? `🔴 ${dialog.unreadCount}` : '✅';
                    chatsList += `${index + 1}. ${chat.title || chat.firstName || chat.username} ${unread}\n`;
                });
                
                await client.sendMessage(chatId, {
                    message: chatsList
                });
            }
            
            // Handle /info command
            else if (command === '/info') {
                const chat = await client.getEntity(chatId);
                await client.sendMessage(chatId, {
                    message: `💡 **Chat Information**\n\n` +
                            `📝 **Name:** ${chat.title || chat.firstName || 'Private Chat'}\n` +
                            `🆔 **ID:** ${chat.id}\n` +
                            `👥 **Type:** ${chat.className}\n` +
                            `📛 **Username:** ${chat.username || 'None'}\n` +
                            `✅ **Verified:** ${chat.verified ? 'Yes' : 'No'}\n` +
                            `🤖 **Bot:** ${chat.bot ? 'Yes' : 'No'}`
                });
            }
            
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    // Send welcome message to saved messages
    try {
        await client.sendMessage('me', {
            message: `✅ **UserBot Started Successfully!**\n\n` +
                    `I'm now active and ready to respond to your commands.\n` +
                    `Send /menu to see available commands.\n\n` +
                    `Session: ${sessionId.substring(0, 12)}...\n` +
                    `Started: ${new Date().toLocaleString()}`
        });
    } catch (error) {
        console.log('Could not send welcome message:', error.message);
    }

    console.log(`Userbot event handler registered for session: ${sessionId}`);
}

// API to check session status
app.get('/api/session/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const clientData = activeClients.get(sessionId);
    
    if (!clientData) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        // Check if client is still connected
        await clientData.client.getMe();
        
        res.json({
            success: true,
            isConnected: true,
            connectedAt: clientData.connectedAt,
            username: clientData.user.username,
            firstName: clientData.user.firstName,
            userId: clientData.user.id,
            uptime: Date.now() - clientData.connectedAt.getTime()
        });
    } catch (error) {
        // Client is disconnected
        activeClients.delete(sessionId);
        res.status(404).json({ error: 'Session disconnected' });
    }
});

// API to disconnect session
app.post('/api/session/:sessionId/disconnect', async (req, res) => {
    const sessionId = req.params.sessionId;
    const clientData = activeClients.get(sessionId);
    
    if (!clientData) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        await clientData.client.disconnect();
        activeClients.delete(sessionId);
        res.json({ success: true, message: 'Session disconnected successfully' });
    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({ error: 'Failed to disconnect session' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        activeSessions: activeSessions.size,
        activeClients: activeClients.size,
        uptime: process.uptime()
    });
});

// Cleanup expired sessions every hour
nodeCron.schedule('0 * * * *', () => {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean temporary auth sessions (older than 1 hour)
    for (const [sessionId, sessionData] of activeSessions.entries()) {
        if (now - sessionData.createdAt > 60 * 60 * 1000) {
            if (sessionData.client) {
                sessionData.client.disconnect();
            }
            activeSessions.delete(sessionId);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} expired sessions`);
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    
    // Disconnect all clients
    for (const [sessionId, clientData] of activeClients.entries()) {
        try {
            await clientData.client.disconnect();
            console.log(`Disconnected session: ${sessionId}`);
        } catch (error) {
            console.error(`Error disconnecting session ${sessionId}:`, error);
        }
    }
    
    process.exit(0);
});

// Catch-all handler
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Telegram UserBot Host running on port ${PORT}`);
    console.log(`📍 Visit: http://localhost:${PORT}`);
    console.log(`❤️  Health check: http://localhost:${PORT}/health`);
    console.log(`🤖 Ready to connect real Telegram accounts!`);
});
