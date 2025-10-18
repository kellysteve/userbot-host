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
        
        console.log('Requesting verification code from Telegram...');
        
        // FIXED: Use the simplest approach for sendCode
        const result = await client.sendCode(phone, {
            apiId: parseInt(apiId),
            apiHash: apiHash,
        });

        // Store temporary session data
        activeSessions.set(sessionId, {
            client,
            phone,
            apiId: parseInt(apiId),
            apiHash,
            phoneCodeHash: result.phoneCodeHash,
            createdAt: Date.now()
        });

        console.log('✅ Verification code requested successfully for:', phone);
        console.log('📱 Telegram should send the code to your account shortly...');
        
        res.json({ 
            success: true, 
            sessionId,
            message: '✅ Verification code requested! Telegram will send the code to your account. Please check your Telegram app and enter the code below.'
        });
    } catch (error) {
        console.error('❌ Telegram auth error:', error);
        
        let errorMessage = 'Failed to request verification code: ';
        if (error.message.includes('PHONE_NUMBER_INVALID')) {
            errorMessage = '❌ Invalid phone number format';
        } else if (error.message.includes('API_ID_INVALID')) {
            errorMessage = '❌ Invalid API ID or API Hash';
        } else if (error.message.includes('FLOOD')) {
            errorMessage = '❌ Too many attempts. Please wait before trying again.';
        } else if (error.message.includes('PHONE_NUMBER_BANNED')) {
            errorMessage = '❌ This phone number is banned from Telegram';
        } else if (error.message.includes('PHONE_NUMBER_FLOOD')) {
            errorMessage = '❌ Too many verification attempts with this number';
        } else {
            errorMessage += error.message;
        }
        
        res.status(500).json({ error: errorMessage });
    }
});

// API endpoint to verify code and start userbot
app.post('/api/verify-code', async (req, res) => {
    const { sessionId, code, password } = req.body;
    
    console.log('🔐 Verification attempt for session:', sessionId);
    console.log('📝 Code provided:', code);
    
    if (!sessionId || !code) {
        return res.status(400).json({ error: 'Missing session ID or verification code' });
    }

    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) {
        return res.status(404).json({ error: 'Session not found or expired. Please start over.' });
    }

    try {
        const { client, phone, phoneCodeHash } = sessionData;
        
        console.log('🔄 Attempting to sign in with verification code...');
        
        let user;
        try {
            // FIXED: Use the start() method instead of signIn() for better compatibility
            await client.start({
                phoneNumber: phone,
                phoneCode: async () => code,
                phoneCodeHash: phoneCodeHash,
                onError: (err) => console.log('Start error:', err),
            });
            
            user = await client.getMe();
            console.log('✅ Sign in successful with verification code');
        } catch (signInError) {
            console.log('⚠️ Start method failed, trying alternative approach:', signInError.message);
            
            // Alternative approach using invoke
            try {
                const { Api } = require('telegram/tl');
                await client.invoke(new Api.auth.SignIn({
                    phoneNumber: phone,
                    phoneCodeHash: phoneCodeHash,
                    phoneCode: code,
                }));
                
                user = await client.getMe();
                console.log('✅ Sign in successful with alternative method');
            } catch (invokeError) {
                console.log('⚠️ Alternative method failed:', invokeError.message);
                
                // If 2FA password is required
                if (invokeError.error_message === 'SESSION_PASSWORD_NEEDED') {
                    console.log('🔒 Two-factor authentication detected');
                    if (!password) {
                        return res.status(400).json({ 
                            error: '🔒 Two-factor authentication is enabled on your account. Please enter your 2FA password.', 
                            requires2FA: true 
                        });
                    }
                    
                    console.log('🔄 Attempting to sign in with 2FA password...');
                    // Handle 2FA
                    await client.invoke(new Api.auth.CheckPassword({
                        password: password,
                    }));
                    user = await client.getMe();
                    console.log('✅ Sign in successful with 2FA password');
                } else {
                    throw invokeError;
                }
            }
        }

        console.log('✅ Successfully authenticated as:', user.username || user.firstName || `User ${user.id}`);
        
        // Start the userbot functionality
        console.log('🚀 Starting userbot functionality...');
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
            message: `🎉 Successfully connected as ${user.firstName || user.username || 'User'}! Your userbot is now running and ready to respond to commands.`,
            username: user.username,
            firstName: user.firstName,
            userId: user.id,
            sessionId: sessionId
        });
    } catch (error) {
        console.error('❌ Verification error:', error);
        
        let errorMessage = 'Failed to verify code: ';
        if (error.message === 'PHONE_CODE_INVALID' || error.error_message === 'PHONE_CODE_INVALID') {
            errorMessage = '❌ Invalid verification code. Please check the code and try again.';
        } else if (error.error_message === 'PHONE_CODE_EXPIRED') {
            errorMessage = '❌ Verification code has expired. Please request a new code.';
        } else if (error.error_message === 'SESSION_PASSWORD_NEEDED') {
            errorMessage = '❌ Two-factor authentication is required for this account. Please provide your 2FA password.';
        } else if (error.message.includes('FLOOD_WAIT')) {
            errorMessage = '❌ Too many attempts. Please wait before trying again.';
        } else {
            errorMessage += error.error_message || error.message;
        }
        
        res.status(500).json({ error: errorMessage });
    }
});

// Real UserBot functionality
async function startUserBot(client, sessionId, user) {
    console.log(`🤖 Starting real userbot for: ${user.firstName || user.username || `User ${user.id}`}`);
    
    // Handle incoming messages
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;
            if (!message || !message.text) return;
            
            const command = message.text.toLowerCase().trim();
            const chatId = message.chatId;
            
            // Handle /menu command
            if (command === '/menu' || command === '/start') {
                const deploymentAge = new Date() - DEPLOYMENT_TIME;
                const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
                const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
                
                await client.sendMessage(chatId, {
                    message: `🤖 **Telegram UserBot Active!**\n\n` +
                            `👤 User: ${user.firstName || user.username || 'You'}\n` +
                            `🆔 ID: ${user.id}\n` +
                            `🔗 Session: ${sessionId.substring(0, 8)}...\n` +
                            `⏰ Connected: ${new Date().toLocaleString()}\n` +
                            `🚀 Deployed: ${hours}h ${minutes}m ${seconds}s ago\n` +
                            `🌐 Host: Render Web Service\n\n` +
                            `**Available Commands:**\n` +
                            `/menu - Show this menu\n` +
                            `/ping - Test bot responsiveness\n` +
                            `/status - Detailed bot status\n` +
                            `/info - Get chat information\n` +
                            `/uptime - Server deployment time`
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
                const deploymentAge = new Date() - DEPLOYMENT_TIME;
                
                const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
                const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
                
                await client.sendMessage(chatId, {
                    message: `📊 **Bot Status Report**\n\n` +
                            `🟢 **Status:** Online & Active\n` +
                            `👤 **Logged in as:** ${user.firstName || user.username || 'You'}\n` +
                            `💾 **Memory Usage:** ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB\n` +
                            `🕐 **Server Uptime:** ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m\n` +
                            `🚀 **Deployed:** ${hours}h ${minutes}m ${seconds}s ago\n` +
                            `📅 **Server Time:** ${new Date().toLocaleString()}\n` +
                            `🔗 **Active Sessions:** ${activeClients.size}\n` +
                            `⚡ **Platform:** Node.js ${process.version}`
                });
            }
            
            // Handle /uptime command
            else if (command === '/uptime') {
                const deploymentAge = new Date() - DEPLOYMENT_TIME;
                const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
                const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
                
                await client.sendMessage(chatId, {
                    message: `⏰ **Deployment Information**\n\n` +
                            `🚀 **Deployed at:** ${DEPLOYMENT_TIME.toLocaleString()}\n` +
                            `⏳ **Running for:** ${hours} hours, ${minutes} minutes, ${seconds} seconds\n` +
                            `📊 **Active userbots:** ${activeClients.size}\n` +
                            `🕐 **Current time:** ${new Date().toLocaleString()}`
                });
            }
            
            // Handle /info command
            else if (command === '/info') {
                try {
                    const chat = await client.getEntity(chatId);
                    await client.sendMessage(chatId, {
                        message: `💡 **Chat Information**\n\n` +
                                `📝 **Name:** ${chat.title || chat.firstName || 'Private Chat'}\n` +
                                `🆔 **ID:** ${chat.id}\n` +
                                `👥 **Type:** ${chat.className}\n` +
                                `📛 **Username:** @${chat.username || 'None'}\n` +
                                `✅ **Verified:** ${chat.verified ? 'Yes' : 'No'}\n` +
                                `🤖 **Bot:** ${chat.bot ? 'Yes' : 'No'}`
                    });
                } catch (error) {
                    await client.sendMessage(chatId, {
                        message: `❌ Could not fetch chat information: ${error.message}`
                    });
                }
            }
            
        } catch (error) {
            console.error('❌ Error handling message:', error);
        }
    });

    // Send welcome message to saved messages
    try {
        const deploymentAge = new Date() - DEPLOYMENT_TIME;
        const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
        const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
        
        await client.sendMessage('me', {
            message: `✅ **UserBot Started Successfully!**\n\n` +
                    `I'm now active and ready to respond to your commands.\n` +
                    `Send /menu to see available commands.\n\n` +
                    `**Session Details:**\n` +
                    `🔗 Session: ${sessionId.substring(0, 12)}...\n` +
                    `⏰ Started: ${new Date().toLocaleString()}\n` +
                    `🚀 Server deployed: ${hours}h ${minutes}m ${seconds}s ago\n\n` +
                    `**Available Commands:**\n` +
                    `/menu - Show bot menu\n` +
                    `/ping - Test responsiveness\n` +
                    `/status - Bot status\n` +
                    `/info - Chat information\n` +
                    `/uptime - Server uptime`
        });
        console.log('✅ Welcome message sent to saved messages');
    } catch (error) {
        console.log('⚠️ Could not send welcome message:', error.message);
    }

    console.log(`✅ Userbot event handler registered for session: ${sessionId}`);
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

// Health check endpoint with deployment info
app.get('/health', (req, res) => {
    const now = new Date();
    const deploymentAge = now - DEPLOYMENT_TIME;
    const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
    const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
    
    res.json({ 
        status: 'OK', 
        timestamp: now.toISOString(),
        deployedAt: DEPLOYMENT_TIME.toISOString(),
        deploymentAge: `${hours}h ${minutes}m ${seconds}s`,
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
        console.log(`🧹 Cleaned up ${cleaned} expired sessions`);
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    
    // Disconnect all clients
    for (const [sessionId, clientData] of activeClients.entries()) {
        try {
            await clientData.client.disconnect();
            console.log(`✅ Disconnected session: ${sessionId}`);
        } catch (error) {
            console.error(`❌ Error disconnecting session ${sessionId}:`, error);
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
    
    // Log deployment time on startup
    console.log(`⏰ Server deployed at: ${DEPLOYMENT_TIME.toLocaleString()}`);
});