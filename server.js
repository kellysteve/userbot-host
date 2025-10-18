const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { api } = require('telegram-mtproto');
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

// API endpoint to start authentication
app.post('/api/start-auth', async (req, res) => {
    const { phone, apiId, apiHash } = req.body;
    
    console.log('Auth request received for:', phone);
    
    if (!phone || !apiId || !apiHash) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const sessionId = crypto.randomBytes(16).toString('hex');
        
        console.log('Creating Telegram client for session:', sessionId);
        
        // Create MTProto client
        const client = api({
            api_id: parseInt(apiId),
            api_hash: apiHash
        });

        console.log('Requesting verification code from Telegram...');
        
        // Send code request
        const phoneCodeHash = await client('auth.sendCode', {
            phone_number: phone,
            settings: {
                _: 'codeSettings'
            }
        });

        console.log('✅ Code request successful, phoneCodeHash:', phoneCodeHash.phone_code_hash);

        // Store temporary session data
        activeSessions.set(sessionId, {
            client,
            phone,
            apiId: parseInt(apiId),
            apiHash,
            phoneCodeHash: phoneCodeHash.phone_code_hash,
            createdAt: Date.now()
        });

        console.log('✅ Verification code sent to:', phone);
        
        res.json({ 
            success: true, 
            sessionId,
            message: '✅ Telegram has sent you a verification code! Please check your Telegram app and enter the 5-digit code below.'
        });
    } catch (error) {
        console.error('Telegram auth error:', error);
        
        let errorMessage = 'Failed to send code: ';
        if (error.error_message === 'PHONE_NUMBER_INVALID') {
            errorMessage = 'Invalid phone number format';
        } else if (error.error_message === 'API_ID_INVALID') {
            errorMessage = 'Invalid API ID or API Hash';
        } else if (error.error_message === 'FLOOD') {
            errorMessage = 'Too many attempts. Please wait before trying again.';
        } else {
            errorMessage += error.error_message || error.message;
        }
        
        res.status(500).json({ error: errorMessage });
    }
});

// API endpoint to verify code
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
        
        // Sign in with the code
        const authResult = await client('auth.signIn', {
            phone_number: phone,
            phone_code_hash: phoneCodeHash,
            phone_code: code
        });

        console.log('✅ Successfully signed in');

        // Get user info
        const user = await client('users.getFullUser', {
            id: {
                _: 'inputUserSelf'
            }
        });

        const userInfo = user.users[0];
        
        console.log('✅ User:', userInfo.first_name || userInfo.username);
        
        // Start the userbot functionality
        await startUserBot(client, sessionId, userInfo);
        
        // Store the active client
        activeClients.set(sessionId, {
            client,
            user: userInfo,
            connectedAt: new Date()
        });

        // Remove from temporary sessions
        activeSessions.delete(sessionId);

        console.log('🎉 Userbot started successfully!');
        
        res.json({ 
            success: true, 
            message: `✅ Successfully connected as ${userInfo.first_name || userInfo.username || 'User'}! Your userbot is now running.`,
            username: userInfo.username,
            firstName: userInfo.first_name,
            sessionId: sessionId
        });
    } catch (error) {
        console.error('Verification error:', error);
        
        let errorMessage = 'Failed to verify code: ';
        if (error.error_message === 'PHONE_CODE_INVALID') {
            errorMessage = 'Invalid verification code. Please check and try again.';
        } else if (error.error_message === 'PHONE_CODE_EXPIRED') {
            errorMessage = 'Code expired. Please request a new one.';
        } else if (error.error_message === 'SESSION_PASSWORD_NEEDED') {
            errorMessage = 'Two-factor authentication is required. Please use account without 2FA for this demo.';
        } else {
            errorMessage += error.error_message || error.message;
        }
        
        res.status(500).json({ error: errorMessage });
    }
});

// Simple UserBot functionality
async function startUserBot(client, sessionId, user) {
    console.log(`Starting userbot for: ${user.first_name || user.username}`);
    
    // Simple polling for new messages (since telegram-mtproto doesn't have event handlers)
    const pollInterval = setInterval(async () => {
        try {
            // Get updates
            const updates = await client('messages.getHistory', {
                peer: {
                    _: 'inputPeerSelf'
                },
                limit: 1
            });
            
            if (updates.messages && updates.messages.length > 0) {
                const message = updates.messages[0];
                if (message.message) {
                    const command = message.message.toLowerCase().trim();
                    
                    // Handle /menu command
                    if (command === '/menu') {
                        const deploymentAge = new Date() - DEPLOYMENT_TIME;
                        const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
                        const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
                        const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
                        
                        await client('messages.sendMessage', {
                            peer: {
                                _: 'inputPeerSelf'
                            },
                            message: `🤖 **UserBot Active!**\n\n` +
                                    `✅ Connected: ${user.first_name || user.username}\n` +
                                    `🔗 Session: ${sessionId.substring(0, 8)}...\n` +
                                    `⏰ Online: ${new Date().toLocaleString()}\n` +
                                    `🚀 Uptime: ${hours}h ${minutes}m ${seconds}s\n\n` +
                                    `**Commands:**\n` +
                                    `/menu - Show this\n` +
                                    `/ping - Test bot`,
                            random_id: Math.floor(Math.random() * 1000000000)
                        });
                    }
                    
                    // Handle /ping command
                    else if (command === '/ping') {
                        await client('messages.sendMessage', {
                            peer: {
                                _: 'inputPeerSelf'
                            },
                            message: '🏓 Pong! Bot is working!',
                            random_id: Math.floor(Math.random() * 1000000000)
                        });
                    }
                }
            }
        } catch (error) {
            console.error('Error in userbot:', error);
        }
    }, 5000); // Check every 5 seconds

    // Store the interval so we can clear it later
    activeClients.get(sessionId).pollInterval = pollInterval;

    // Send welcome message
    try {
        await client('messages.sendMessage', {
            peer: {
                _: 'inputPeerSelf'
            },
            message: `✅ **UserBot Started!**\n\n` +
                    `I'm now active! Send /menu to see commands.\n` +
                    `Session: ${sessionId.substring(0, 12)}...`,
            random_id: Math.floor(Math.random() * 1000000000)
        });
        console.log('✅ Welcome message sent');
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
        // Simple check if client is still working
        await clientData.client('help.getConfig');
        res.json({ success: true, isConnected: true });
    } catch (error) {
        // Clear interval and remove session
        if (clientData.pollInterval) {
            clearInterval(clientData.pollInterval);
        }
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
        // Clear polling interval
        if (clientData.pollInterval) {
            clearInterval(clientData.pollInterval);
        }
        activeClients.delete(sessionId);
        res.json({ success: true, message: 'Session disconnected successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to disconnect session' });
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

// Cleanup expired sessions
nodeCron.schedule('0 * * * *', () => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [sessionId, sessionData] of activeSessions.entries()) {
        if (now - sessionData.createdAt > 60 * 60 * 1000) {
            activeSessions.delete(sessionId);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} expired sessions`);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Visit: http://localhost:${PORT}`);
    console.log(`✅ Ready to connect Telegram accounts!`);
});