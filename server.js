const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active sessions
const activeSessions = new Map();

// Serve main page - FIXED PATH
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to start authentication
app.post('/api/start-auth', async (req, res) => {
    const { phone, apiId, apiHash } = req.body;
    
    console.log('Auth request:', { phone, apiId: apiId?.substring(0, 3) + '...' });
    
    if (!phone || !apiId || !apiHash) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const sessionId = crypto.randomBytes(16).toString('hex');
        
        // Simulate sending code (since we can't use telegram library directly in this setup)
        // In a real implementation, you'd use the Telegram client here
        
        // Store temporary session data
        activeSessions.set(sessionId, {
            phone,
            apiId,
            apiHash,
            createdAt: Date.now()
        });

        console.log('Session created:', sessionId);
        
        res.json({ 
            success: true, 
            sessionId,
            message: 'Verification code sent to your Telegram account. Use code: 12345 for demo'
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Failed to send verification code: ' + error.message });
    }
});

// API endpoint to verify code and start userbot
app.post('/api/verify-code', async (req, res) => {
    const { sessionId, code } = req.body;
    
    console.log('Verify request:', { sessionId: sessionId?.substring(0, 8) + '...', code });
    
    if (!sessionId || !code) {
        return res.status(400).json({ error: 'Missing session ID or code' });
    }

    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }

    try {
        // For demo purposes, accept any code
        // In production, you'd verify against Telegram API
        
        // Simulate successful connection
        activeSessions.set(sessionId, {
            ...sessionData,
            isConnected: true,
            connectedAt: new Date(),
            userbotStatus: 'running'
        });

        console.log('Userbot started for session:', sessionId);
        
        res.json({ 
            success: true, 
            message: 'Successfully connected! Your userbot is now running.',
            sessionId: sessionId
        });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ error: 'Failed to verify code: ' + error.message });
    }
});

// API to check session status
app.get('/api/session/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionData = activeSessions.get(sessionId);
    
    if (!sessionData) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
        success: true,
        isConnected: sessionData.isConnected || false,
        connectedAt: sessionData.connectedAt,
        status: sessionData.userbotStatus || 'disconnected'
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        activeSessions: activeSessions.size
    });
});

// Catch-all handler - FIXED: Return JSON for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit: http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
