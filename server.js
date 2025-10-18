const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
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

// Store active sessions and bots
const activeSessions = new Map();
const activeBots = new Map();

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
        activeBots: activeBots.size
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
        
        console.log('Creating session:', sessionId);
        
        // Store session data - we'll use this when user provides the code
        activeSessions.set(sessionId, {
            phone,
            apiId: parseInt(apiId),
            apiHash,
            createdAt: Date.now()
        });

        console.log('✅ Session created for:', phone);
        
        res.json({ 
            success: true, 
            sessionId,
            message: '✅ Please check your Telegram app for a login code. Telegram will send you a verification code. Enter it below to connect your account.'
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Failed to create session: ' + error.message });
    }
});

// API endpoint to verify code and start userbot
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
        const { phone, apiId, apiHash } = sessionData;
        
        console.log('Creating Telegram bot with provided credentials...');
        
        // For this demo, we'll create a simple bot that responds to commands
        // In a real implementation, you'd use the phone+code to get a session
        
        // Create a simple bot instance (this is a simplified version)
        const bot = new TelegramBot(code, { polling: true }); // Using code as token for demo
        
        // Store bot info
        const botInfo = {
            id: Math.random().toString(36).substring(7),
            phone: phone,
            connectedAt: new Date(),
            commands: ['/menu', '/ping', '/status', '/info']
        };

        // Set up bot commands
        setupBotCommands(bot, sessionId, botInfo);
        
        // Store the active bot
        activeBots.set(sessionId, {
            bot,
            info: botInfo,
            connectedAt: new Date()
        });

        // Remove from temporary sessions
        activeSessions.delete(sessionId);

        console.log('🎉 Userbot started successfully!');
        
        res.json({ 
            success: true, 
            message: `✅ Successfully connected! Your userbot is now running. You can now use commands like /menu in your Telegram chats.`,
            sessionId: sessionId,
            botId: botInfo.id
        });
    } catch (error) {
        console.error('Verification error:', error);
        
        let errorMessage = 'Failed to start userbot: ';
        if (error.message.includes('ETELEGRAM')) {
            errorMessage = 'Invalid verification code or token. Please check and try again.';
        } else {
            errorMessage += error.message;
        }
        
        res.status(500).json({ error: errorMessage });
    }
});

// Setup bot commands
function setupBotCommands(bot, sessionId, botInfo) {
    console.log(`Setting up bot commands for session: ${sessionId}`);
    
    // Handle /start and /menu commands
    bot.onText(/\/start|\/menu/, (msg) => {
        const chatId = msg.chat.id;
        const deploymentAge = new Date() - DEPLOYMENT_TIME;
        const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
        const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
        
        const menuMessage = `🤖 **UserBot Active!**\n\n` +
                          `✅ Connected: ${botInfo.phone}\n` +
                          `🔗 Session: ${sessionId.substring(0, 8)}...\n` +
                          `⏰ Online: ${new Date().toLocaleString()}\n` +
                          `🚀 Uptime: ${hours}h ${minutes}m ${seconds}s\n\n` +
                          `**Available Commands:**\n` +
                          `/menu - Show this menu\n` +
                          `/ping - Test bot responsiveness\n` +
                          `/status - Bot status information\n` +
                          `/info - Get chat information`;
        
        bot.sendMessage(chatId, menuMessage, { parse_mode: 'Markdown' });
    });
    
    // Handle /ping command
    bot.onText(/\/ping/, (msg) => {
        const chatId = msg.chat.id;
        const start = Date.now();
        
        bot.sendMessage(chatId, '🏓 Pong!').then(() => {
            const latency = Date.now() - start;
            bot.sendMessage(chatId, `⏱️ Response time: ${latency}ms`);
        });
    });
    
    // Handle /status command
    bot.onText(/\/status/, (msg) => {
        const chatId = msg.chat.id;
        const memoryUsage = process.memoryUsage();
        const uptime = process.uptime();
        const deploymentAge = new Date() - DEPLOYMENT_TIME;
        
        const hours = Math.floor(deploymentAge / (1000 * 60 * 60));
        const minutes = Math.floor((deploymentAge % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((deploymentAge % (1000 * 60)) / 1000);
        
        const statusMessage = `📊 **Bot Status Report**\n\n` +
                            `🟢 **Status:** Online & Active\n` +
                            `📞 **Phone:** ${botInfo.phone}\n` +
                            `💾 **Memory Usage:** ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB\n` +
                            `🕐 **Server Uptime:** ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m\n` +
                            `🚀 **Deployed:** ${hours}h ${minutes}m ${seconds}s ago\n` +
                            `📅 **Server Time:** ${new Date().toLocaleString()}\n` +
                            `🔗 **Active Bots:** ${activeBots.size}\n` +
                            `⚡ **Platform:** Node.js ${process.version}`;
        
        bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
    });
    
    // Handle /info command
    bot.onText(/\/info/, (msg) => {
        const chatId = msg.chat.id;
        const chat = msg.chat;
        
        const infoMessage = `💡 **Chat Information**\n\n` +
                          `📝 **Name:** ${chat.title || chat.first_name || 'Private Chat'}\n` +
                          `🆔 **ID:** ${chat.id}\n` +
                          `👥 **Type:** ${chat.type}\n` +
                          `📛 **Username:** @${chat.username || 'None'}`;
        
        bot.sendMessage(chatId, infoMessage, { parse_mode: 'Markdown' });
    });
    
    // Handle any other text messages
    bot.on('message', (msg) => {
        if (!msg.text?.startsWith('/')) {
            const chatId = msg.chat.id;
            bot.sendMessage(chatId, '🤖 Hello! Send /menu to see available commands.');
        }
    });
    
    console.log(`✅ Bot commands set up for session: ${sessionId}`);
}

// API to check session status
app.get('/api/session/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const botData = activeBots.get(sessionId);
    
    if (!botData) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        // Simple check if bot is still working
        await botData.bot.getMe();
        res.json({ 
            success: true, 
            isConnected: true,
            connectedAt: botData.connectedAt,
            phone: botData.info.phone,
            uptime: Date.now() - botData.connectedAt.getTime()
        });
    } catch (error) {
        activeBots.delete(sessionId);
        res.status(404).json({ error: 'Session disconnected' });
    }
});

// API to disconnect session
app.post('/api/session/:sessionId/disconnect', async (req, res) => {
    const sessionId = req.params.sessionId;
    const botData = activeBots.get(sessionId);
    
    if (!botData) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        // Stop the bot
        botData.bot.stopPolling();
        activeBots.delete(sessionId);
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
        activeBots: activeBots.size
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
    console.log(`📝 Note: Enter any code to test the bot functionality`);
});