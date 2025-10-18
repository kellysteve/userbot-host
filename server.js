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

// Deployment timestamp
const DEPLOYMENT_TIME = new Date();
console.log(`🚀 Application deployed at: ${DEPLOYMENT_TIME.toLocaleString()}`);

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

// API endpoint to get deployment info
app.get('/api/deployment-info', (req, res) => {
    const now = new Date();
    const uptime = process.uptime();
    const deploymentAge = now - DEPLOYMENT_TIME;
    
    res.json({
        deployedAt: DEPLOYMENT_TIME.toISOString(),
        deployedAtReadable: DEPLOYMENT_TIME.toLocaleString(),
        serverTime: now.toISOString(),
        serverUptime: uptime,
        deploymentAge: deploymentAge,
        activeSessions: activeSessions.size,
        activeClients: activeClients.size
    });
});

// API endpoint to start authentication - SIMPLE & WORKING
app.post('/api/start-auth', async (req, res) => {
    const { phone, apiId, apiHash } = req.body;
    
    console.log('Auth request received for:', phone);
    
    if (!phone || !apiId || !apiHash) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const sessionId = crypto.randomBytes(16).toString('hex');
        const stringSession = new StringSession('');
        
        console.log('Creating Telegram client for session:', sessionId);
        
        const client = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
            connectionRetries: 5,
        });

        await client.connect();
        
        console.log('Requesting verification code from Telegram...');
        
        // ULTRA SIMPLE: Just phone number - THIS WORKS
        const result = await client.sendCode(phone);
        
        console.log('✅ Telegram accepted code request');

        // Store temporary session data
        activeSessions.set(sessionId, {
            client,
            phone,
            apiId: parseInt(apiId),
            apiHash,
            phoneCodeHash: result.phoneCodeHash,
            createdAt: Date.now()
        });

        console.log('✅ Verification code sent to:', phone);
        console.log('📱 Waiting for user to input the code...');
        
        res.json({ 
            success: true, 
            sessionId,
            message: '✅ Telegram has sent you a verification code! Please check your Telegram app and enter the 5-digit code below.'
        });
    } catch (error) {
        console.error('Telegram auth error:', error);
        
        let errorMessage = 'Failed to send code: ';
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

// API endpoint to verify code - SIMPLE & WORKING
app.post('/api/verify-code', async (req, res) => {
    const { sessionId, code } = req.body;
    
    console.log('Verification attempt for session:', sessionId);
    console.log('Code provided:', code);
    
    if (!sessionId || !code) {
        return res.status(400).json({ error: 'Missing session ID or code' });
    }

    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) {
        return res.status(404).json({ error: 'Session not found. Please start over.' });
    }

    try {
        const { client, phone, phoneCodeHash } = sessionData;
        
        console.log('Signing in with code...');
        
        // SIMPLE SIGN IN - THIS WORKS
        const user = await client.signIn({
            phoneNumber: phone,
            phoneCode: async () => code,
            phoneCodeHash: phoneCodeHash,
        });

        console.log('✅ Successfully signed in as:', user.username || user.firstName);
        
        // Start the userbot
        await startUserBot(client, sessionId, user);
        
        // Store the active client
        activeClients.set(sessionId, {
            client,
            user: user,
            connectedAt: new Date(),
            sessionString: client.session.save()
        });

        // Remove from temporary sessions
        activeSessions.delete(sessionId);

        console.log('🎉 Userbot started successfully!');
        
        res.json({ 
            success: true, 
            message: `✅ Successfully connected! Your userbot is now running. You can now use commands like /menu in your Telegram chats.`,
            username: user.username,
            firstName: user.firstName,
            sessionId: sessionId
        });
    } catch (error) {
        console.error('Verification error:', error);
        
        let errorMessage = 'Failed to verify code: ';
        if (error.message.includes('PHONE_CODE_INVALID')) {
            errorMessage = 'Invalid verification code. Please check and try again.';
        } else if (error.message.includes('PHONE_CODE_EXPIRED')) {
            errorMessage = 'Code expired. Please request a new one.';
        } else {
            errorMessage += error.message;
        }
        
        res.status(500).json({ error: errorMessage });
    }
});

// UserBot functionality
async function startUserBot(client, sessionId, user) {
    console.log(`Starting userbot for: ${user.firstName || user.username}`);
    
    // Handle incoming messages
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;
            if (!message || !message.text) return;
            
            const command = message.text.toLowerCase().trim();
            const chatId = message.chatId;
            
            // Handle /menu command
            if (command === '/menu') {
                const deploymentAge = new Date() - DEPLOYMENT_TIME;
                const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
                const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
                
                await client.sendMessage(chatId, {
                    message: `🤖 **UserBot Active!**\n\n` +
                            `✅ Connected: ${user.firstName || user.username}\n` +
                            `🔗 Session: ${sessionId.substring(0, 8)}...\n` +
                            `⏰ Online: ${new Date().toLocaleString()}\n` +
                            `🚀 Uptime: ${hours}h ${minutes}m ${seconds}s\n\n` +
                            `**Commands:**\n` +
                            `/menu - Show this\n` +
                            `/ping - Test bot\n` +
                            `/status - Bot status`
                });
            }
            
            // Handle /ping command
            else if (command === '/ping') {
                const start = Date.now();
                await client.sendMessage(chatId, { message: '🏓 Pong!' });
                const latency = Date.now() - start;
                await client.sendMessage(chatId, { 
                    message: `⏱️ Response: ${latency}ms` 
                });
            }
            
            // Handle /status command
            else if (command === '/status') {
                await client.sendMessage(chatId, {
                    message: `🟢 Bot Status: ONLINE\n` +
                            `👤 User: ${user.firstName || user.username}\n` +
                            `💻 Host: Render\n` +
                            `✅ All systems operational`
                });
            }
            
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    // Send welcome message
    try {
        await client.sendMessage('me', {
            message: `✅ **UserBot Started!**\n\n` +
                    `I'm now active! Send /menu to see commands.\n` +
                    `Session: ${sessionId.substring(0, 12)}...`
        });
    } catch (error) {
        console.log('Could not send welcome message');
    }

    console.log(`Userbot started for session: ${sessionId}`);
}

// API to check session status
app.get('/api/session/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const clientData = activeClients.get(sessionId);
    
    if (!clientData) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        await clientData.client.getMe();
        res.json({ success: true, isConnected: true });
    } catch (error) {
        activeClients.delete(sessionId);
        res.status(404).json({ error: 'Session disconnected' });
    }
});

// Health check
app.get('/health', (req, res) => {
    const now = new Date();
    const deploymentAge = now - DEPLOYMENT_TIME;
    const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
    const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
    
    res.json({ 
        status: 'OK', 
        deploymentAge: `${hours}h ${minutes}m ${seconds}s`,
        activeSessions: activeSessions.size,
        activeClients: activeClients.size
    });
});

// Cleanup
nodeCron.schedule('0 * * * *', () => {
    const now = Date.now();
    for (const [sessionId, sessionData] of activeSessions.entries()) {
        if (now - sessionData.createdAt > 60 * 60 * 1000) {
            if (sessionData.client) sessionData.client.disconnect();
            activeSessions.delete(sessionId);
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit: http://localhost:${PORT}`);
});