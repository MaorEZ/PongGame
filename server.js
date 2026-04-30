// Backend Server - Node.js + WebSocket for real-time multiplayer
// Run this with: node server.js

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient: createSupabase } = require('@supabase/supabase-js');

const db = createSupabase(
    'https://qfzbhjnksngtlihuovcm.supabase.co',
    'sb_publishable_wXqf6IXKxjlMknuLEFKT8w_r2KfM8tr'
);

// Load a user's persisted stats from Supabase
async function loadUserStats(userId) {
    try {
        const { data } = await db.from('game_stats')
            .select('*').eq('user_id', String(userId)).single();
        return data;
    } catch { return null; }
}

// Persist user stats after a match (fire-and-forget)
function persistUserStats(userId, user) {
    db.from('game_stats').upsert({
        user_id: String(userId),
        username: user.name,
        balance: user.balance,
        elo: user.elo || ELO_START,
        wins: user.wins || 0,
        losses: user.losses || 0,
        earnings: user.earnings || 0,
        matches_played: user.matchesPlayed || 0,
        total_wagered: user.totalWagered || 0,
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' }).then(({ error }) => {
        if (error) console.error('[DB] Persist error:', error.message);
    });
}

// ── Security Config ───────────────────────────────────────────────────────────
const PORT = 3000;

// Your Telegram user ID(s) — only these can use admin commands
// Find your ID by messaging @userinfobot on Telegram
const ADMIN_IDS = new Set([
    // '123456789',  // ← add your Telegram user ID here (as a string)
]);

// Your Telegram bot token — set via environment variable for safety
// In production: BOT_TOKEN=your_token node server.js
const BOT_TOKEN = process.env.BOT_TOKEN || '';

// ── ELO & Stake Gate Config ───────────────────────────────────────────────────
const ELO_START          = 100;  // starting rating for all new players
const NEW_ACCOUNT_MATCHES = 10;  // matches before stake limit lifts
const NEW_ACCOUNT_MAX_BET = 5;   // max bet (USDT) during new-account period

// Verify Telegram initData hash — prevents userId spoofing from bots/scripts
function verifyTelegramInitData(initData) {
    if (!BOT_TOKEN || !initData) return true; // skip if not configured (dev mode)
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;
        params.delete('hash');
        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        return computedHash === hash;
    } catch (e) {
        return false;
    }
}


// ── Server-Authoritative Physics World ───────────────────────────────────────
const WORLD_W    = 400;
const WORLD_H    = 600;
const PADDLE_W   = 96;
const PADDLE_H   = 16;
const BALL_R     = 8;
const P1_Y       = WORLD_H - 30 - PADDLE_H;  // 554 — bottom paddle top-edge
const P2_Y       = 30;                         // top paddle top-edge
const BASE_SPEED = 11;
const MAX_SPEED  = 20;
const TICK_MS    = 16;  // ~60 fps physics

// Seeded PRNG (mulberry32) — same algorithm as client for consistent feel
function mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Initialize ball and paddles for a round using seeded PRNG
function initBallForRound(game) {
    if (!game.ballSeed) game.ballSeed = Math.floor(Math.random() * 2147483647);
    const roundSeed = (game.ballSeed ^ (game.currentRound * 9001)) >>> 0;
    const rng = mulberry32(roundSeed);
    const hBias = (rng() - 0.5) * 3.4;
    const vSpeed = Math.sqrt(BASE_SPEED * BASE_SPEED - hBias * hBias);
    game.ball = {
        x: WORLD_W / 2, y: WORLD_H / 2,
        speedX: hBias, speedY: (rng() > 0.5 ? -1 : 1) * vSpeed,
        rampUpStartTime: Date.now(), rampUpDuration: 3000, hitCount: 0
    };
    game.paddle1 = { x: (WORLD_W - PADDLE_W) / 2, y: P1_Y, width: PADDLE_W, height: PADDLE_H };
    game.paddle2 = { x: (WORLD_W - PADDLE_W) / 2, y: P2_Y, width: PADDLE_W, height: PADDLE_H };
    console.log(`[BALL] round=${game.currentRound} seed=${roundSeed} vx=${game.ball.speedX.toFixed(2)} vy=${game.ball.speedY.toFixed(2)}`);
}

// Start/stop the server-side physics loop
// Uses drift-corrected setTimeout so the event loop can't bunch up missed ticks
function startPhysicsLoop(game) {
    if (game.physicsTimeout) return;
    console.log(`[PHYSICS] Starting loop for game ${game.id}`);
    let expected = Date.now() + TICK_MS;
    function tick() {
        serverTick(game);
        if (!game.physicsTimeout) return;
        const drift = Date.now() - expected;
        expected += TICK_MS;
        game.physicsTimeout = setTimeout(tick, Math.max(0, TICK_MS - drift));
    }
    game.physicsTimeout = setTimeout(tick, TICK_MS);
}
function stopPhysicsLoop(game) {
    if (game.physicsTimeout) {
        clearTimeout(game.physicsTimeout);
        game.physicsTimeout = null;
        console.log(`[PHYSICS] Stopped loop for game ${game.id}`);
    }
}

// Server physics tick — runs at ~60fps, owns all ball motion and collision
function serverTick(game) {
    if (game.status !== 'active') { stopPhysicsLoop(game); return; }
    const ball = game.ball;
    const now = Date.now();

    // Speed ramp-up (0-3 seconds: 30% → 100%)
    const elapsed = now - ball.rampUpStartTime;
    const ramp = elapsed < ball.rampUpDuration ? 0.3 + 0.7 * (elapsed / ball.rampUpDuration) : 1.0;

    const prevX = ball.x, prevY = ball.y;
    const effX = ball.speedX * ramp, effY = ball.speedY * ramp;
    ball.x += effX; ball.y += effY;

    // Wall bounces (left / right)
    if (ball.x - BALL_R < 0)      { ball.x = BALL_R;          ball.speedX = Math.abs(ball.speedX); }
    if (ball.x + BALL_R > WORLD_W) { ball.x = WORLD_W - BALL_R; ball.speedX = -Math.abs(ball.speedX); }

    // Ensure minimum vertical speed to prevent horizontal loops
    const spd = Math.sqrt(ball.speedX * ball.speedX + ball.speedY * ball.speedY);
    if (Math.abs(ball.speedY) < spd * 0.4) {
        const ys = ball.speedY >= 0 ? 1 : -1, xs = ball.speedX >= 0 ? 1 : -1;
        ball.speedY = ys * spd * 0.7;
        ball.speedX = xs * Math.sqrt(Math.max(0, spd * spd - ball.speedY * ball.speedY));
    }

    // Lag-compensated paddle positions — use where the player had their paddle
    // at (now - RTT/2), i.e. the last input they could have sent given their ping
    const p1lag = getLagPaddleX(game.paddle1History, game.paddle1.x, (game.player1RTT || 0) / 2);
    const p2lag = getLagPaddleX(game.paddle2History, game.paddle2.x, (game.player2RTT || 0) / 2);

    // Paddle 1 collision (bottom paddle)
    const pBot = prevY + BALL_R, cBot = ball.y + BALL_R;
    const crossP1 = pBot <= P1_Y && cBot >= P1_Y;
    let p1cx = ball.x;
    if (crossP1 && cBot !== pBot) p1cx = prevX + effX * ((P1_Y - pBot) / (cBot - pBot));
    if ((crossP1 || (cBot > P1_Y && cBot < P1_Y + PADDLE_H)) &&
        p1cx > p1lag - BALL_R && p1cx < p1lag + PADDLE_W + BALL_R && ball.speedY > 0) {
        ball.y = P1_Y - BALL_R;
        const angle = ((p1cx - p1lag) / PADDLE_W - 0.5) * (Math.PI / 3);
        const ns = spd + BASE_SPEED * 0.08;
        ball.speedX = Math.sin(angle) * ns;
        ball.speedY = -Math.abs(Math.cos(angle) * ns);
        ball.hitCount++;
    }

    // Paddle 2 collision (top paddle)
    const p2Bot = P2_Y + PADDLE_H;
    const pTop = prevY - BALL_R, cTop = ball.y - BALL_R;
    const crossP2 = pTop >= p2Bot && cTop <= p2Bot;
    let p2cx = ball.x;
    if (crossP2 && cTop !== pTop) p2cx = prevX + effX * ((p2Bot - pTop) / (cTop - pTop));
    if ((crossP2 || (cTop < p2Bot && cTop > P2_Y)) &&
        p2cx > p2lag - BALL_R && p2cx < p2lag + PADDLE_W + BALL_R && ball.speedY < 0) {
        ball.y = p2Bot + BALL_R;
        const angle = ((p2cx - p2lag) / PADDLE_W - 0.5) * (Math.PI / 3);
        const ns = spd + BASE_SPEED * 0.08;
        ball.speedX = Math.sin(angle) * ns;
        ball.speedY = Math.abs(Math.cos(angle) * ns);
        ball.hitCount++;
    }

    // Speed cap
    const spd2 = Math.sqrt(ball.speedX * ball.speedX + ball.speedY * ball.speedY);
    if (spd2 > MAX_SPEED) { ball.speedX = ball.speedX / spd2 * MAX_SPEED; ball.speedY = ball.speedY / spd2 * MAX_SPEED; }

    // Score detection
    if (ball.y - BALL_R < 0)          { stopPhysicsLoop(game); handleScoreEvent(game, 'player1'); return; }
    if (ball.y + BALL_R > WORLD_H)     { stopPhysicsLoop(game); handleScoreEvent(game, 'player2'); return; }

    // Round timer (40s)
    if (game.roundStartTime && now - game.roundStartTime >= 40000) {
        stopPhysicsLoop(game); handleScoreEvent(game, 'tie'); return;
    }

    // Broadcast authoritative state to both clients
    broadcastToGame(game, {
        type: 'gameState',
        ball: { x: ball.x, y: ball.y, speedX: ball.speedX, speedY: ball.speedY },
        paddle1X: game.paddle1.x, paddle2X: game.paddle2.x, ramp
    });
}

// Server-authoritative score event — called from serverTick, never from client
function handleScoreEvent(game, scoredBy) {
    if (game.status !== 'active') return;
    game.status = 'roundCooldown';
    const COOLDOWN_MS = 3000;

    if (scoredBy === 'player1') game.score.player1++;
    else if (scoredBy === 'player2') game.score.player2++;
    console.log(`[SCORE] Game ${game.id} round ${game.currentRound}: ${scoredBy} scored — ${game.score.player1}:${game.score.player2}`);

    broadcastToGame(game, {
        type: 'roundCooldown',
        score: { player1: game.score.player1, player2: game.score.player2 },
        roundWinner: scoredBy,
        currentRound: game.currentRound,
        cooldownMs: COOLDOWN_MS,
        serverTime: Date.now()
    });

    const gameOver = game.score.player1 >= 2 || game.score.player2 >= 2 || game.currentRound >= 3;

    game.roundCooldownTimer = setTimeout(() => {
        game.roundCooldownTimer = null;
        if (gameOver) {
            const winnerId = game.score.player1 > game.score.player2 ? game.player1Id :
                             game.score.player2 > game.score.player1 ? game.player2Id : null;
            endMultiplayerMatch(game, winnerId, 'score');
        } else {
            game.currentRound++;
            game.status = 'roundCooldown';
            game.roundReadyFlags = { player1: false, player2: false };
            broadcastToGame(game, { type: 'roundResume', currentRound: game.currentRound, serverTime: Date.now() });
            // Safety fallback: start round anyway after 7s if a client doesn't respond
            game.roundReadyTimeout = setTimeout(() => {
                game.roundReadyTimeout = null;
                if (game.status === 'roundCooldown') {
                    console.log(`[ROUND] Timeout — starting round ${game.currentRound} without full ready`);
                    startNewRound(game);
                }
            }, 7000);
        }
    }, COOLDOWN_MS);
}

// Ready barrier — called when a client signals it finished the round countdown
function handleRoundReady(socketId, ws, data) {
    const game = Database.games.get(data.gameId);
    if (!game || !game.roundReadyFlags) return;
    if (data.userId === game.player1Id)      game.roundReadyFlags.player1 = true;
    else if (data.userId === game.player2Id) game.roundReadyFlags.player2 = true;
    console.log(`[ROUND] roundReady from ${data.userId}: p1=${game.roundReadyFlags.player1} p2=${game.roundReadyFlags.player2}`);
    if (game.roundReadyFlags.player1 && game.roundReadyFlags.player2) {
        if (game.roundReadyTimeout) { clearTimeout(game.roundReadyTimeout); game.roundReadyTimeout = null; }
        startNewRound(game);
    }
}

// Start a new round after both clients are ready
function startNewRound(game) {
    game.status = 'active';
    game.roundReadyFlags = null;
    initBallForRound(game);
    game.roundStartTime = Date.now();

    // Provably fair: on round 1, generate secret + commit to the ball seed
    if (game.currentRound === 1) {
        game.serverSecret = crypto.randomBytes(16).toString('hex');
        game.fairCommitment = crypto.createHash('sha256')
            .update(game.ballSeed.toString() + game.serverSecret)
            .digest('hex');
    }

    broadcastToGame(game, {
        type: 'roundStart',
        currentRound: game.currentRound,
        ball: { x: game.ball.x, y: game.ball.y, speedX: game.ball.speedX, speedY: game.ball.speedY },
        paddle1X: game.paddle1.x, paddle2X: game.paddle2.x,
        serverTime: Date.now(),
        fairCommitment: game.currentRound === 1 ? game.fairCommitment : undefined
    });
    startPhysicsLoop(game);
    startPingLoop(game);
    console.log(`[ROUND] Round ${game.currentRound} started`);
}

// In-memory database (in production, use PostgreSQL or MongoDB)
const Database = {
    users: new Map(), // userId -> { name, balance, socketId, wins, losses, earnings, referralCode, referredBy, firstMatchDone }
    games: new Map(), // gameId -> { id, creatorId, player1Id, player2Id, betAmount, status, score }
    activeSockets: new Map(), // socketId -> { userId, ws }
    reports: [], // User reports
    bans: new Map(), // userId/IP -> { reason, timestamp }
    watchlist: new Map(), // userId -> { suspiciousActivity, paddleMoves }
    paddleMoveTiming: new Map(), // userId -> { lastMoveTime, moveCounts }
    rematches: new Map(), // rematchId -> { requesterId, opponentId, betAmount, gameMode, expireTimer }
    referralCodes: new Map() // code -> userId
};

// Create HTTP server
const server = http.createServer((req, res) => {
    // Serve static files
    if (req.url === '/healthz') {
        res.writeHead(200);
        res.end('ok');
    } else if (req.url === '/' || req.url === '/index.html') {
        serveFile(res, 'client/index.html', 'text/html');
    } else if (req.url.endsWith('.css')) {
        serveFile(res, 'client/' + req.url.substring(1), 'text/css');
    } else if (req.url.endsWith('.js')) {
        serveFile(res, 'client/' + req.url.substring(1), 'application/javascript');
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// Serve static files
function serveFile(res, filename, contentType) {
    fs.readFile(path.join(__dirname, filename), (err, data) => {
        if (err) {
            res.writeHead(500);
            res.end('Error loading file');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

// Create WebSocket server
const wss = new WebSocket.Server({ server });

console.log(`Server starting on port ${PORT}...`);

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');

    const socketId = generateId();
    Database.activeSockets.set(socketId, { ws, userId: null });

    // Rate limiting: max 40 messages per 5 seconds per socket
    let msgCount = 0;
    let rateLimitWindow = Date.now();
    const RATE_LIMIT = 40;
    const RATE_WINDOW_MS = 5000;

    // Handle messages from client
    ws.on('message', (message) => {
        // Sliding window rate check
        const now = Date.now();
        if (now - rateLimitWindow > RATE_WINDOW_MS) {
            msgCount = 0;
            rateLimitWindow = now;
        }
        msgCount++;
        if (msgCount > RATE_LIMIT) {
            const socketInfo = Database.activeSockets.get(socketId);
            console.warn(`[RATE LIMIT] Socket ${socketId} (user ${socketInfo && socketInfo.userId}) exceeded ${RATE_LIMIT} msgs/${RATE_WINDOW_MS}ms — dropping`);
            safeSend(ws, { type: 'error', message: 'Too many requests. Slow down.' });
            return;
        }

        try {
            const data = JSON.parse(message);
            handleClientMessage(socketId, ws, data);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        console.log('Client disconnected');
        handleDisconnect(socketId);
    });

    ws.send(JSON.stringify({ type: 'connected', message: 'Connected to game server' }));
    broadcastOnlineCount();
});

// Handle messages from clients
function handleClientMessage(socketId, ws, data) {
    console.log(`[WS<-] ${data.type} from socket ${socketId}`, JSON.stringify(data).substring(0, 200));

    const socketInfo = Database.activeSockets.get(socketId);

    // Reject any message that tries to act as a different user than the registered socket owner.
    // This prevents impersonation: someone can't send data.userId = victim to drain their balance.
    if (data.type !== 'register' && data.userId !== undefined && socketInfo.userId !== null) {
        if (String(data.userId) !== String(socketInfo.userId)) {
            console.warn(`[SECURITY] Socket ${socketId} (user ${socketInfo.userId}) tried to act as ${data.userId} — blocked`);
            safeSend(ws, { type: 'error', message: 'Unauthorized' });
            return;
        }
    }

    switch (data.type) {
        case 'register':
            handleRegister(socketId, ws, data);
            break;

        case 'getBalance':
            handleGetBalance(socketId, ws, data);
            break;

        case 'deposit':
            // Client-triggered deposits are disabled — balance is only credited by
            // verified blockchain callbacks or admin. Silently ignore to not break UI flow.
            safeSend(ws, { type: 'info', message: 'Deposits are processed via blockchain confirmation.' });
            break;

        case 'adminCredit':
            handleAdminCredit(socketId, ws, data);
            break;

        case 'withdraw':
            handleWithdraw(socketId, ws, data);
            break;

        case 'createGame':
            handleCreateGame(socketId, ws, data);
            break;

        case 'getGames':
            handleGetGames(socketId, ws, data);
            break;

        case 'joinGame':
            handleJoinGame(socketId, ws, data);
            break;

        case 'paddleMove':
            handlePaddleMove(socketId, ws, data);
            break;

        case 'pong':
            handlePong(socketId, data);
            break;

        case 'getProfile':
            handleGetProfile(socketId, ws, data);
            break;

        case 'matchEmoji':
            handleMatchEmoji(socketId, ws, data);
            break;

        case 'chatMessage':
            handleChatMessage(socketId, ws, data);
            break;

        case 'getChat':
            handleGetChat(socketId, ws);
            break;

        case 'giftCredits':
            handleGiftCredits(socketId, ws, data);
            break;

        case 'doubleOrNothing':
            handleDoubleOrNothing(socketId, ws, data);
            break;

        case 'doubleOrNothingAccept':
            handleDoubleOrNothingAccept(socketId, ws, data);
            break;

        case 'doubleOrNothingDecline':
            handleDoubleOrNothingDecline(socketId, ws, data);
            break;

        case 'cancelGame':
            handleCancelGame(socketId, ws, data);
            break;

        case 'requestRematch':
            handleRematchRequest(socketId, ws, data);
            break;

        case 'rematchAccept':
            handleRematchAccept(socketId, ws, data);
            break;

        case 'rematchDecline':
            handleRematchDecline(socketId, ws, data);
            break;

        case 'scoreReport':
            // Scoring is now server-authoritative via serverTick — client reports ignored
            console.log('[SCORE] Ignoring client scoreReport (server is authoritative)');
            break;

        case 'roundReady':
            handleRoundReady(socketId, ws, data);
            break;

        case 'submitReport':
            handleSubmitReport(socketId, ws, data);
            break;

        case 'applyReferral':
            handleApplyReferral(socketId, ws, data);
            break;

        case 'getLeaderboard':
            handleGetLeaderboard(socketId, ws, data);
            break;

        case 'getMatchHistory':
            handleGetMatchHistory(socketId, ws, data);
            break;

        case 'adminBan':
            handleAdminBan(socketId, ws, data);
            break;

        case 'clientReady':
            handleClientReady(socketId, ws, data);
            break;

        case 'resync':
            handleResync(socketId, ws, data);
            break;

        case 'gameTimeout':
            handleGameTimeout(socketId, ws, data);
            break;

        default:
            console.log('Unknown message type:', data.type);
    }
}

// Register user
function handleRegister(socketId, ws, data) {
    const userId = data.userId;
    const userName = data.userName;

    // Verify the Telegram initData signature so we know the userId is legitimate
    if (data.initData && !verifyTelegramInitData(data.initData)) {
        console.warn(`[SECURITY] Invalid initData from socket ${socketId} — rejecting registration`);
        safeSend(ws, { type: 'error', message: 'Authentication failed' });
        return;
    }

    // Reject banned users immediately on reconnect
    if (Database.bans.has(String(userId))) {
        const ban = Database.bans.get(String(userId));
        safeSend(ws, { type: 'banned', reason: ban.reason });
        ws.close();
        console.log(`[BAN] Blocked reconnect from banned user ${userId}`);
        return;
    }

    const socketInfo = Database.activeSockets.get(socketId);
    socketInfo.userId = userId;

    let isNewUser = false;
    if (!Database.users.has(userId)) {
        isNewUser = true;
        const refCode = generateReferralCode(userId);
        Database.referralCodes.set(refCode, userId);
        Database.users.set(userId, {
            name: userName,
            balance: 100,
            socketId: socketId,
            wins: 0,
            losses: 0,
            earnings: 0,
            elo: ELO_START,
            matchesPlayed: 0,
            matchHistory: [],
            referralCode: refCode,
            referredBy: null,
            firstMatchDone: false,
            totalWagered: 0
        });
        // Restore persisted stats from Supabase (balance, elo, wins, etc.)
        loadUserStats(userId).then(saved => {
            const user = Database.users.get(userId);
            if (!user || !saved) return;
            user.balance      = saved.balance      ?? 100;
            user.elo          = saved.elo          ?? ELO_START;
            user.wins         = saved.wins         ?? 0;
            user.losses       = saved.losses       ?? 0;
            user.earnings     = saved.earnings     ?? 0;
            user.matchesPlayed = saved.matches_played ?? 0;
            user.totalWagered  = saved.total_wagered  ?? 0;
            const sock = getSocketByUserId(userId);
            safeSend(sock, { type: 'balance', balance: user.balance });
            console.log(`[DB] Restored stats for ${userName}: balance=${user.balance} elo=${user.elo}`);
        }).catch(e => console.error('[DB] Load error:', e.message));
    } else {
        const user = Database.users.get(userId);
        user.socketId = socketId;
        user.name = userName;
    }

    console.log(`User registered: ${userName} (${userId})`);

    const user = Database.users.get(userId);

    // If reconnecting mid-game during grace period, resume
    let resumed = false;
    Database.games.forEach(game => {
        if (!resumed && game.gracePeriodUserId === userId && game.gracePeriodTimer) {
            clearTimeout(game.gracePeriodTimer);
            game.gracePeriodTimer = null;
            game.gracePeriodUserId = null;
            resumed = true;
            console.log(`[RECONNECT] ${userName} reconnected to game ${game.id}`);

            const opponentId = game.player1Id === userId ? game.player2Id : game.player1Id;
            const oppSocket = getSocketByUserId(opponentId);
            safeSend(oppSocket, { type: 'opponentReconnected' });

            // Resume physics if game was active
            if (game.status === 'active') {
                startPhysicsLoop(game);
            }

            // Send current game state to reconnected player
            safeSend(ws, {
                type: 'resyncAfterReconnect',
                gameId: game.id,
                score: game.score,
                currentRound: game.currentRound,
                status: game.status,
                ball: game.ball ? { x: game.ball.x, y: game.ball.y, speedX: game.ball.speedX, speedY: game.ball.speedY } : null,
                paddle1X: game.paddle1 ? game.paddle1.x : (WORLD_W - PADDLE_W) / 2,
                paddle2X: game.paddle2 ? game.paddle2.x : (WORLD_W - PADDLE_W) / 2,
                youAre: game.player1Id === userId ? 'player1' : 'player2'
            });
        }
    });

    ws.send(JSON.stringify({ type: 'balance', balance: user.balance }));
    ws.send(JSON.stringify({ type: 'totalWagered', amount: user.totalWagered || 0 }));
    ws.send(JSON.stringify({ type: 'referralCode', code: user.referralCode }));
    ws.send(JSON.stringify({
        type: 'playerStats',
        elo: user.elo || ELO_START,
        matchesPlayed: user.matchesPlayed || 0
    }));
}

function generateReferralCode(userId) {
    return 'ref_' + String(userId).replace(/[^a-zA-Z0-9]/g, '').substring(0, 8) + Math.random().toString(36).substring(2, 5);
}

// Apply referral code — called when a new user registers via a referral link
function handleApplyReferral(socketId, ws, data) {
    const { userId, code } = data;
    const user = Database.users.get(userId);
    if (!user || user.referredBy || user.firstMatchDone) return; // already referred or played

    const referrerId = Database.referralCodes.get(code);
    if (!referrerId || referrerId === userId) return;

    user.referredBy = referrerId;
    console.log(`[REFERRAL] User ${userId} referred by ${referrerId}`);
    safeSend(ws, { type: 'referralApplied' });
}

// Get leaderboard data — queries Supabase so rankings survive restarts
async function handleGetLeaderboard(socketId, ws, data) {
    try {
        const { data: rows, error } = await db.from('game_stats')
            .select('username, wins, losses, earnings, elo, matches_played')
            .gt('matches_played', 0);

        if (error) throw error;

        const players = (rows || []).map(r => ({
            name: r.username,
            wins: r.wins || 0,
            losses: r.losses || 0,
            earnings: r.earnings || 0,
            elo: r.elo || ELO_START,
            matchesPlayed: r.matches_played || 0
        }));

        const byEarnings = [...players].sort((a, b) => b.earnings - a.earnings).slice(0, 10);
        const byWins     = [...players].sort((a, b) => b.wins - a.wins).slice(0, 10);
        const byElo      = [...players].sort((a, b) => b.elo - a.elo).slice(0, 10);

        safeSend(ws, { type: 'leaderboard', byEarnings, byWins, byElo });
    } catch (e) {
        console.error('[DB] Leaderboard error:', e.message);
        // Fallback to in-memory
        const players = [];
        Database.users.forEach(user => {
            if (user.wins > 0 || user.losses > 0) players.push({
                name: user.name, wins: user.wins, losses: user.losses,
                earnings: user.earnings, elo: user.elo || ELO_START
            });
        });
        const byEarnings = [...players].sort((a, b) => b.earnings - a.earnings).slice(0, 10);
        const byWins     = [...players].sort((a, b) => b.wins - a.wins).slice(0, 10);
        const byElo      = [...players].sort((a, b) => b.elo - a.elo).slice(0, 10);
        safeSend(ws, { type: 'leaderboard', byEarnings, byWins, byElo });
    }
}

// Get match history for the requesting user
function handleGetMatchHistory(socketId, ws, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    const userId = socketInfo.userId;
    const user = Database.users.get(userId);
    if (!user) return;
    safeSend(ws, { type: 'matchHistory', history: user.matchHistory || [] });
}

// Return public profile for any player by name or userId
async function handleGetProfile(socketId, ws, data) {
    const targetId = data.userId;
    const targetName = data.username;

    // Try in-memory first
    let user = targetId ? Database.users.get(targetId) : null;
    if (!user && targetName) {
        Database.users.forEach(u => { if (u.name === targetName) user = u; });
    }

    if (user) {
        const total = (user.wins || 0) + (user.losses || 0);
        safeSend(ws, {
            type: 'profileData',
            name: user.name,
            elo: user.elo || ELO_START,
            wins: user.wins || 0,
            losses: user.losses || 0,
            winRate: total > 0 ? Math.round((user.wins / total) * 100) : 0,
            earnings: user.earnings || 0,
            matchesPlayed: user.matchesPlayed || 0,
            recentMatches: (user.matchHistory || []).slice(0, 5)
        });
        return;
    }

    // Fall back to Supabase for offline players
    try {
        const query = targetId
            ? db.from('game_stats').select('*').eq('user_id', String(targetId)).single()
            : db.from('game_stats').select('*').eq('username', targetName).single();
        const { data: saved } = await query;
        if (saved) {
            const total = (saved.wins || 0) + (saved.losses || 0);
            safeSend(ws, {
                type: 'profileData',
                name: saved.username,
                elo: saved.elo || ELO_START,
                wins: saved.wins || 0,
                losses: saved.losses || 0,
                winRate: total > 0 ? Math.round((saved.wins / total) * 100) : 0,
                earnings: saved.earnings || 0,
                matchesPlayed: saved.matches_played || 0,
                recentMatches: []
            });
        } else {
            safeSend(ws, { type: 'profileData', error: 'Player not found' });
        }
    } catch (e) {
        safeSend(ws, { type: 'profileData', error: 'Player not found' });
    }
}

// Forward a post-match emoji to the opponent (GG / 😤 / 🔥)
function handleMatchEmoji(socketId, ws, data) {
    const ALLOWED = ['GG', '😤', '🔥'];
    if (!ALLOWED.includes(data.emoji)) return;
    const socketInfo = Database.activeSockets.get(socketId);
    const userId = socketInfo.userId;
    // Find the most recent finished game this player was in
    let opponentId = null;
    Database.rematches.forEach(meta => {
        if (meta.player1Id === userId) opponentId = meta.player2Id;
        else if (meta.player2Id === userId) opponentId = meta.player1Id;
    });
    if (!opponentId) return;
    const oppSock = getSocketByUserId(opponentId);
    safeSend(oppSock, { type: 'matchEmoji', emoji: data.emoji });
}

// Get user balance
function handleGetBalance(socketId, ws, data) {
    const userId = data.userId;
    const user = Database.users.get(userId);

    if (user) {
        ws.send(JSON.stringify({
            type: 'balance',
            balance: user.balance
        }));
    }
}

// Admin-only: manually credit a user's balance (used until real payment processing is live)
function handleAdminCredit(socketId, ws, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    const requesterId = socketInfo.userId;

    if (!ADMIN_IDS.has(String(requesterId))) {
        console.warn(`[SECURITY] Non-admin ${requesterId} tried to credit balance`);
        safeSend(ws, { type: 'error', message: 'Unauthorized' });
        return;
    }

    const targetUserId = data.targetUserId;
    const amount = parseFloat(data.amount);

    if (!targetUserId || isNaN(amount) || amount <= 0) {
        safeSend(ws, { type: 'error', message: 'Invalid credit parameters' });
        return;
    }

    const target = Database.users.get(targetUserId);
    if (!target) {
        safeSend(ws, { type: 'error', message: 'User not found' });
        return;
    }

    target.balance += amount;
    const targetSocket = getSocketByUserId(targetUserId);
    safeSend(targetSocket, { type: 'balance', balance: target.balance });
    safeSend(ws, { type: 'info', message: `Credited $${amount} to ${target.name}` });
    console.log(`[ADMIN] ${requesterId} credited $${amount} to ${targetUserId}`);
}

// Handle withdrawal
function handleWithdraw(socketId, ws, data) {
    const userId = data.userId;
    const amount = parseFloat(data.amount);

    const user = Database.users.get(userId);

    // Anti-smurf: must have wagered at least $10 before withdrawing
    if (user && (user.totalWagered || 0) < 10) {
        safeSend(ws, { type: 'error', message: 'You must wager at least $10 before withdrawing.' });
        return;
    }

    if (user && user.balance >= amount) {
        const fee = parseFloat((amount * 0.01).toFixed(4));
        const netPayout = parseFloat((amount - fee).toFixed(4));
        user.balance -= amount;

        ws.send(JSON.stringify({ type: 'balance', balance: user.balance }));
        ws.send(JSON.stringify({ type: 'withdrawalProcessed', amount, fee, netPayout }));

        console.log(`Withdrawal: User ${userId} withdrew ${amount} (fee $${fee}, net $${netPayout})`);
    } else {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Insufficient balance'
        }));
    }
}

// Create game
function handleCreateGame(socketId, ws, data) {
    const userId = data.userId;
    const betAmount = parseFloat(data.betAmount);

    const user = Database.users.get(userId);

    if (!user || user.balance < betAmount) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Insufficient balance'
        }));
        return;
    }

    // New-account stake limit — prevents smurf accounts from farming high-stakes rooms
    if ((user.matchesPlayed || 0) < NEW_ACCOUNT_MATCHES && betAmount > NEW_ACCOUNT_MAX_BET) {
        safeSend(ws, { type: 'error', message: `New accounts are limited to $${NEW_ACCOUNT_MAX_BET} bets for the first ${NEW_ACCOUNT_MATCHES} matches.` });
        return;
    }

    // Deduct bet from balance
    user.balance -= betAmount;
    user.totalWagered = (user.totalWagered || 0) + betAmount;

    // Create game
    const gameId = generateId();
    const game = {
        id: gameId,
        creatorId: userId,
        creatorName: user.name,
        player1Id: userId,
        player1Name: user.name,
        player2Id: null,
        player2Name: null,
        betAmount: betAmount,
        gameMode: data.gameMode || 'classic',
        status: 'waiting',
        score: { player1: 0, player2: 0 },
        currentRound: 1,
        ball: { x: 0, y: 0, speedX: 0, speedY: 0 }
    };

    Database.games.set(gameId, game);

    console.log(`Game created: ${gameId} by ${user.name} with bet ${betAmount}`);

    ws.send(JSON.stringify({
        type: 'gameCreated',
        game: game
    }));

    // Update balance
    ws.send(JSON.stringify({
        type: 'balance',
        balance: user.balance
    }));
}

// Get available games (filtered by budget only — mode filter removed so all rooms are visible)
function handleGetGames(socketId, ws, data) {
    const maxBudget = parseFloat(data.maxBudget) || 9999;
    const availableRooms = [];

    Database.games.forEach(game => {
        if (game.status === 'waiting' &&
            game.betAmount <= maxBudget) {
            availableRooms.push({
                id: game.id,
                playerName: game.creatorName,
                playerId: game.creatorId,
                mode: game.gameMode || 'classic',
                amount: game.betAmount
            });
        }
    });

    ws.send(JSON.stringify({
        type: 'roomsList',
        rooms: availableRooms
    }));
}

// Join game — server-authoritative countdown then match start
function handleJoinGame(socketId, ws, data) {
    const userId = data.userId;
    const gameId = data.gameId;

    console.log(`[JOIN] userId=${userId} wants to join gameId=${gameId}`);

    const user = Database.users.get(userId);
    const game = Database.games.get(gameId);

    if (!game) {
        console.log(`[JOIN] FAIL — game not found: ${gameId}`);
        ws.send(JSON.stringify({ type: 'joinFailed', reason: 'Room no longer exists' }));
        return;
    }

    if (game.status !== 'waiting') {
        console.log(`[JOIN] FAIL — game not open, status: ${game.status}`);
        ws.send(JSON.stringify({ type: 'joinFailed', reason: 'Room already started' }));
        return;
    }

    if (!user || user.balance < game.betAmount) {
        console.log(`[JOIN] FAIL — insufficient balance`);
        ws.send(JSON.stringify({ type: 'joinFailed', reason: 'Insufficient balance' }));
        return;
    }


    // New-account stake limit
    if ((user.matchesPlayed || 0) < NEW_ACCOUNT_MATCHES && game.betAmount > NEW_ACCOUNT_MAX_BET) {
        ws.send(JSON.stringify({ type: 'joinFailed', reason: `New accounts are limited to $${NEW_ACCOUNT_MAX_BET} bets for the first ${NEW_ACCOUNT_MATCHES} matches.` }));
        return;
    }

    // Deduct bet
    user.balance -= game.betAmount;
    user.totalWagered = (user.totalWagered || 0) + game.betAmount;

    // Assign player 2
    game.player2Id = userId;
    game.player2Name = user.name;
    game.status = 'countdown';

    console.log(`[JOIN] SUCCESS — ${game.player1Name} vs ${game.player2Name}, starting countdown`);

    const player1Socket = getSocketByUserId(game.player1Id);
    const player2Socket = ws;

    const gameMode = game.gameMode || 'classic';
    const matchInfo = {
        roomId: game.id,
        player1Name: game.player1Name,
        player2Name: game.player2Name,
        betAmount: game.betAmount,
        gameMode: gameMode
    };

    // Tell player2 (joiner) join was accepted
    safeSend(player2Socket, {
        type: 'joinAccepted',
        ...matchInfo,
        youAre: 'guest'
    });

    // Tell player1 (host) someone joined
    safeSend(player1Socket, {
        type: 'joinAccepted',
        ...matchInfo,
        youAre: 'host'
    });

    // Send updated balance to player2
    safeSend(player2Socket, { type: 'balance', balance: user.balance });

    // --- Server-authoritative countdown ---
    const COUNTDOWN_SECS = 10;
    let secondsLeft = COUNTDOWN_SECS;

    // Send initial countdown
    broadcastToGame(game, { type: 'matchCountdown', roomId: game.id, secondsLeft });

    game.countdownTimer = setInterval(() => {
        secondsLeft--;

        if (secondsLeft <= 0) {
            clearInterval(game.countdownTimer);
            game.countdownTimer = null;

            // Verify both still connected
            const p1 = getSocketByUserId(game.player1Id);
            const p2 = getSocketByUserId(game.player2Id);

            if (!p1 || !p2) {
                console.log(`[MATCH] Aborted — player disconnected before start`);
                cancelCountdownGame(game, 'Opponent disconnected');
                return;
            }

            // Move to ready-check phase — wait for both clients to load game screen
            game.status = 'readyCheck';
            game.p1Ready = false;
            game.p2Ready = false;

            const gameData = {
                id: game.id,
                player1Id: game.player1Id,
                player1Name: game.player1Name,
                player2Id: game.player2Id,
                player2Name: game.player2Name,
                betAmount: game.betAmount,
                gameMode: gameMode,
                isAIGame: false
            };

            console.log(`[MATCH] Sending matchReady to both: ${game.player1Name} vs ${game.player2Name}`);

            // Shared random seed — both clients must produce identical ball trajectories
            gameData.ballSeed = Math.floor(Math.random() * 0xFFFFFF);
            game.ballSeed = gameData.ballSeed;

            safeSend(p1, { type: 'matchReady', game: gameData, youAre: 'player1' });
            safeSend(p2, { type: 'matchReady', game: gameData, youAre: 'player2' });

            // Safety timeout — if both aren't ready within 12s, cancel
            game.readyTimeout = setTimeout(() => {
                if (game.status === 'readyCheck') {
                    console.log(`[MATCH] Ready timeout — not all players ready`);
                    cancelCountdownGame(game, 'Match setup timed out');
                }
            }, 12000);

            return;
        }

        // Tick countdown to both
        broadcastToGame(game, { type: 'matchCountdown', roomId: game.id, secondsLeft });
    }, 1000);
}

// Safe send — won't throw if socket is dead
function safeSend(ws, data) {
    try {
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify(data));
        } else {
            console.log('[WS] safeSend skipped — socket not open');
        }
    } catch (e) {
        console.error('[WS] safeSend error:', e.message);
    }
}

// Cancel a game that's in countdown
function cancelCountdownGame(game, reason) {
    if (game.countdownTimer) { clearInterval(game.countdownTimer); game.countdownTimer = null; }
    if (game.readyTimeout) { clearTimeout(game.readyTimeout); game.readyTimeout = null; }
    if (game.raceTimer) { clearTimeout(game.raceTimer); game.raceTimer = null; }

    // Refund both players
    const p1User = Database.users.get(game.player1Id);
    const p2User = Database.users.get(game.player2Id);
    if (p1User) p1User.balance += game.betAmount;
    if (p2User) p2User.balance += game.betAmount;

    // Notify both
    const p1Sock = getSocketByUserId(game.player1Id);
    const p2Sock = getSocketByUserId(game.player2Id);

    const msg = { type: 'matchCancelled', roomId: game.id, reason: reason };
    safeSend(p1Sock, msg);
    safeSend(p2Sock, msg);

    // Send updated balances
    if (p1User) safeSend(p1Sock, { type: 'balance', balance: p1User.balance });
    if (p2User) safeSend(p2Sock, { type: 'balance', balance: p2User.balance });

    // Remove game
    Database.games.delete(game.id);
    console.log(`[MATCH] Cancelled: ${game.id} — ${reason}`);
}

// Handle client reporting ready on game screen
function handleClientReady(socketId, ws, data) {
    const userId = data.userId;
    const roomId = data.roomId;
    const game = Database.games.get(roomId);

    if (!game) {
        console.log(`[READY] Game not found: ${roomId}`);
        safeSend(ws, { type: 'matchCancelled', roomId, reason: 'Game not found' });
        return;
    }

    if (game.status !== 'readyCheck') {
        console.log(`[READY] Game ${roomId} not in readyCheck, status: ${game.status}`);
        // If game already active (race countdown started), resend the race info
        if (game.status === 'racing' && game.raceStartAt) {
            safeSend(ws, { type: 'raceCountdown', roomId, startAtEpochMs: game.raceStartAt, durationMs: 5000 });
        }
        return;
    }

    if (userId === game.player1Id) {
        game.p1Ready = true;
        console.log(`[READY] Player1 (${game.player1Name}) ready`);
    } else if (userId === game.player2Id) {
        game.p2Ready = true;
        console.log(`[READY] Player2 (${game.player2Name}) ready`);
    } else {
        console.log(`[READY] Unknown player ${userId} for game ${roomId}`);
        return;
    }

    // Check if both ready
    if (game.p1Ready && game.p2Ready) {
        // Clear ready timeout
        if (game.readyTimeout) { clearTimeout(game.readyTimeout); game.readyTimeout = null; }

        console.log(`[MATCH] Both players ready — starting race countdown`);
        startRaceCountdown(game);
    }
}

// Start the 5-second race countdown (NFS style)
function startRaceCountdown(game) {
    game.status = 'racing';
    const RACE_DURATION = 5000;
    const startAt = Date.now() + 300; // 300ms buffer for network
    game.raceStartAt = startAt;

    const p1 = getSocketByUserId(game.player1Id);
    const p2 = getSocketByUserId(game.player2Id);

    const msg = { type: 'raceCountdown', roomId: game.id, startAtEpochMs: startAt, durationMs: RACE_DURATION, serverTime: Date.now() };
    console.log(`[RACE] Broadcasting raceCountdown, startAt=${startAt}`);
    safeSend(p1, msg);
    safeSend(p2, msg);

    // Schedule gameplay start
    const gameplayStartAt = startAt + RACE_DURATION;
    game.raceTimer = setTimeout(() => {
        game.raceTimer = null;

        // Verify still connected
        const pp1 = getSocketByUserId(game.player1Id);
        const pp2 = getSocketByUserId(game.player2Id);
        if (!pp1 || !pp2) {
            console.log(`[RACE] Player disconnected before gameplay start`);
            cancelCountdownGame(game, 'Opponent disconnected');
            return;
        }

        // Don't start physics yet — wait for both clients to send roundReady
        game.status = 'roundCooldown';
        game.score = { player1: 0, player2: 0 };
        game.currentRound = 1;
        game.roundReadyFlags = { player1: false, player2: false };
        initBallForRound(game); // pre-init so resync can send state
        const startMsg = { type: 'gameplayStart', roomId: game.id, serverTime: Date.now() };
        console.log(`[RACE] Broadcasting gameplayStart`);
        safeSend(pp1, startMsg);
        safeSend(pp2, startMsg);
        // Safety fallback: start anyway if a client is slow
        game.roundReadyTimeout = setTimeout(() => {
            game.roundReadyTimeout = null;
            if (game.status === 'roundCooldown') {
                console.log(`[ROUND] Round 1 timeout — starting anyway`);
                startNewRound(game);
            }
        }, 5000);
    }, gameplayStartAt - Date.now());
}

// Handle resync request from client
function handleResync(socketId, ws, data) {
    const roomId = data.roomId;
    const game = Database.games.get(roomId);

    console.log(`[RESYNC] Request for room ${roomId}`);

    if (!game) {
        safeSend(ws, { type: 'matchCancelled', roomId, reason: 'Game not found' });
        return;
    }

    switch (game.status) {
        case 'readyCheck':
            // Resend matchReady
            const gameData = {
                id: game.id, player1Id: game.player1Id, player1Name: game.player1Name,
                player2Id: game.player2Id, player2Name: game.player2Name,
                betAmount: game.betAmount, gameMode: game.gameMode || 'classic', isAIGame: false
            };
            const isP1 = data.userId === game.player1Id;
            safeSend(ws, { type: 'matchReady', game: gameData, youAre: isP1 ? 'player1' : 'player2' });
            break;
        case 'racing':
            if (game.raceStartAt) {
                safeSend(ws, { type: 'raceCountdown', roomId, startAtEpochMs: game.raceStartAt, durationMs: 5000, serverTime: Date.now() });
            }
            break;
        case 'active':
            // Send current physics snapshot so client can resume rendering
            safeSend(ws, {
                type: 'gameState',
                ball: game.ball
                    ? { x: game.ball.x, y: game.ball.y, speedX: game.ball.speedX, speedY: game.ball.speedY }
                    : { x: WORLD_W / 2, y: WORLD_H / 2, speedX: 0, speedY: 0 },
                paddle1X: game.paddle1 ? game.paddle1.x : (WORLD_W - PADDLE_W) / 2,
                paddle2X: game.paddle2 ? game.paddle2.x : (WORLD_W - PADDLE_W) / 2,
                ramp: 1.0
            });
            break;
        case 'roundCooldown':
            safeSend(ws, {
                type: 'roundCooldown',
                score: game.score,
                roundWinner: 'unknown',
                currentRound: game.currentRound,
                cooldownMs: 0,
                serverTime: Date.now()
            });
            // If in ready-barrier phase, re-trigger roundResume so client re-sends roundReady
            if (game.roundReadyFlags) {
                safeSend(ws, { type: 'roundResume', currentRound: game.currentRound, serverTime: Date.now() });
            }
            break;
        default:
            safeSend(ws, { type: 'matchCancelled', roomId, reason: 'Match no longer active' });
    }
}

// Handle paddle movement with anti-cheat
function handlePaddleMove(socketId, ws, data) {
    const gameId = data.gameId;
    const currentTime = Date.now();

    const game = Database.games.get(gameId);
    if (!game || game.status !== 'active') return;

    const socketInfo = Database.activeSockets.get(socketId);
    const userId = socketInfo.userId;

    // Anti-cheat: Timing validation
    if (!Database.paddleMoveTiming.has(userId)) {
        Database.paddleMoveTiming.set(userId, {
            lastMoveTime: currentTime,
            moveCounts: [],
            totalMoves: 0
        });
    }

    const timing = Database.paddleMoveTiming.get(userId);

    // Check if move is too fast (0ms = bot-like behavior)
    const timeSinceLastMove = currentTime - timing.lastMoveTime;

    if (timeSinceLastMove === 0 && timing.totalMoves > 5) {
        // Suspicious: Multiple 0ms moves
        flagSuspiciousActivity(userId, 'Bot-like paddle movements (0ms timing)');
        console.warn(`Suspicious activity detected: User ${userId} - 0ms paddle moves`);
    }

    // Track move timing
    timing.moveCounts.push(timeSinceLastMove);
    timing.lastMoveTime = currentTime;
    timing.totalMoves++;

    // Keep only last 20 moves for analysis
    if (timing.moveCounts.length > 20) {
        timing.moveCounts.shift();
    }

    // Analyze pattern - if too many moves with identical timing, flag it
    if (timing.moveCounts.length >= 10) {
        const avgTiming = timing.moveCounts.reduce((a, b) => a + b, 0) / timing.moveCounts.length;
        const variance = timing.moveCounts.reduce((sum, val) => sum + Math.pow(val - avgTiming, 2), 0) / timing.moveCounts.length;

        // Very low variance = robotic pattern
        if (variance < 5 && avgTiming < 50) {
            flagSuspiciousActivity(userId, 'Robotic paddle pattern detected');
        }
    }

    // Update server-side paddle position from normalized fraction
    // Client sends xFraction (0-1); server maps to virtual world x-coordinate
    const xFraction = Math.max(0, Math.min(1, data.xFraction !== undefined ? data.xFraction : (data.x || 0) / WORLD_W));
    const vx = xFraction * (WORLD_W - PADDLE_W);
    if (userId === game.player1Id && game.paddle1) {
        game.paddle1.x = vx;
        if (!game.paddle1History) game.paddle1History = [];
        game.paddle1History.push({ x: vx, t: currentTime });
        if (game.paddle1History.length > 20) game.paddle1History.shift();
    } else if (userId === game.player2Id && game.paddle2) {
        game.paddle2.x = vx;
        if (!game.paddle2History) game.paddle2History = [];
        game.paddle2History.push({ x: vx, t: currentTime });
        if (game.paddle2History.length > 20) game.paddle2History.shift();
    }
    // No per-paddle broadcast — serverTick broadcasts all positions every 16ms
}

// Return the paddle x closest to (now - lagMs) from history, fallback to current
function getLagPaddleX(history, currentX, lagMs) {
    if (!history || history.length === 0) return currentX;
    const target = Date.now() - lagMs;
    let best = history[0];
    for (const h of history) {
        if (Math.abs(h.t - target) < Math.abs(best.t - target)) best = h;
    }
    return best.x;
}

// Handle pong reply — compute RTT and store on game
function handlePong(socketId, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    if (!socketInfo) return;
    const userId = socketInfo.userId;
    const rtt = Math.min(Date.now() - data.t, 500);
    Database.games.forEach(game => {
        if (game.player1Id === userId) game.player1RTT = rtt;
        if (game.player2Id === userId) game.player2RTT = rtt;
    });
}

// Start periodic RTT measurement for a game
function startPingLoop(game) {
    if (game.pingInterval) return;
    game.pingInterval = setInterval(() => {
        const now = Date.now();
        const p1 = getSocketByUserId(game.player1Id);
        const p2 = getSocketByUserId(game.player2Id);
        safeSend(p1, { type: 'ping', t: now });
        safeSend(p2, { type: 'ping', t: now });
    }, 2000);
}
function stopPingLoop(game) {
    if (game.pingInterval) { clearInterval(game.pingInterval); game.pingInterval = null; }
}

// Flag suspicious activity
function flagSuspiciousActivity(userId, reason) {
    if (!Database.watchlist.has(userId)) {
        Database.watchlist.set(userId, {
            userId: userId,
            flags: [],
            timestamp: Date.now()
        });
    }

    const entry = Database.watchlist.get(userId);
    entry.flags.push({
        reason: reason,
        timestamp: Date.now()
    });

    console.log(`🚩 User ${userId} flagged: ${reason}`);
}

// Start game logic (server-side physics)
function startGameLogic(game) {
    // Initialize ball position (simplified - full physics on server)
    game.ball = {
        x: 200,
        y: 300,
        speedX: 3,
        speedY: 3
    };

    // Simulate game rounds (in production, this would be real-time physics)
    simulateGame(game);
}

// Simulate game (simplified for demo)
function simulateGame(game) {
    // Simulate rounds with random winner
    setTimeout(() => {
        const winner = Math.random() > 0.5 ? 1 : 2;

        if (winner === 1) {
            game.score.player1++;
        } else {
            game.score.player2++;
        }

        // Broadcast score update
        broadcastToGame(game, {
            type: 'gameUpdate',
            score: game.score,
            roundEnd: true,
            roundWinner: winner
        });

        // Check if game is over (best of 3)
        if (game.score.player1 === 2 || game.score.player2 === 2) {
            endGame(game);
        } else {
            // Continue to next round
            game.currentRound++;
            simulateGame(game);
        }
    }, 5000); // Each round lasts 5 seconds (for demo)
}

// End game
function endGame(game) {
    game.status = 'finished';

    const winnerId = game.score.player1 === 2 ? game.player1Id : game.player2Id;
    const loserId = winnerId === game.player1Id ? game.player2Id : game.player1Id;

    // Calculate winnings
    const totalPot = game.betAmount * 2;
    const platformFee = totalPot * 0.05; // 5% fee
    const winAmount = totalPot - platformFee;

    // Update balances
    const winner = Database.users.get(winnerId);
    winner.balance += winAmount;

    console.log(`Game ${game.id} ended. Winner: ${winner.name}, Prize: ${winAmount}`);

    // Notify both players
    const player1Socket = getSocketByUserId(game.player1Id);
    const player2Socket = getSocketByUserId(game.player2Id);

    if (player1Socket) {
        const isWinner = winnerId === game.player1Id;
        player1Socket.send(JSON.stringify({
            type: 'gameEnd',
            winnerId: winnerId,
            winAmount: isWinner ? winAmount : 0,
            betAmount: game.betAmount,
            newBalance: Database.users.get(game.player1Id).balance
        }));
    }

    if (player2Socket) {
        const isWinner = winnerId === game.player2Id;
        player2Socket.send(JSON.stringify({
            type: 'gameEnd',
            winnerId: winnerId,
            winAmount: isWinner ? winAmount : 0,
            betAmount: game.betAmount,
            newBalance: Database.users.get(game.player2Id).balance
        }));
    }

    // Remove game from active games
    Database.games.delete(game.id);
}

// Broadcast message to all players in a game
function broadcastToGame(game, message) {
    const player1Socket = getSocketByUserId(game.player1Id);
    const player2Socket = getSocketByUserId(game.player2Id);

    const msgStr = JSON.stringify(message);

    if (player1Socket) player1Socket.send(msgStr);
    if (player2Socket) player2Socket.send(msgStr);
}

// Get socket by user ID
function getSocketByUserId(userId) {
    const user = Database.users.get(userId);
    if (!user) return null;

    const socketInfo = Database.activeSockets.get(user.socketId);
    return socketInfo ? socketInfo.ws : null;
}

// Handle client disconnect
function handleDisconnect(socketId) {
    const socketInfo = Database.activeSockets.get(socketId);

    if (socketInfo && socketInfo.userId) {
        Database.games.forEach(game => {
            const isPlayer = game.player1Id === socketInfo.userId || game.player2Id === socketInfo.userId;
            if (!isPlayer) return;

            if (game.status === 'countdown' || game.status === 'readyCheck' || game.status === 'racing') {
                // Cancel pre-game phase and refund both players
                console.log(`[DISCONNECT] Player left during ${game.status}: ${game.id}`);
                cancelCountdownGame(game, 'Opponent disconnected');
            } else if (game.status === 'waiting' && game.creatorId === socketInfo.userId) {
                // Creator disconnected while waiting — just remove the room
                console.log(`[DISCONNECT] Creator left waiting room: ${game.id}`);
                Database.games.delete(game.id);
            } else if (game.status === 'active' || game.status === 'roundCooldown') {
                // Start 15-second grace period before forfeiting
                console.log(`[DISCONNECT] Player left active game: ${game.id} — starting 15s grace`);
                stopPhysicsLoop(game);
                game.gracePeriodUserId = socketInfo.userId;

                const opponentId = game.player1Id === socketInfo.userId ? game.player2Id : game.player1Id;
                const oppSocket = getSocketByUserId(opponentId);
                safeSend(oppSocket, { type: 'opponentDisconnected', graceSecs: 15 });

                game.gracePeriodTimer = setTimeout(() => {
                    game.gracePeriodTimer = null;
                    game.gracePeriodUserId = null;
                    console.log(`[DISCONNECT] Grace expired for game ${game.id} — forfeiting`);
                    const winnerId = opponentId;
                    endMultiplayerMatch(game, winnerId, 'opponent_disconnected');
                }, 15000);
            }
        });
    }

    Database.activeSockets.delete(socketId);
    broadcastOnlineCount();
}

function broadcastOnlineCount() {
    const count = Database.activeSockets.size;
    const msg = JSON.stringify({ type: 'onlineCount', count });
    Database.activeSockets.forEach(({ ws }) => {
        if (ws.readyState === 1) ws.send(msg);
    });
}

// Cancel game (waiting room)
function handleCancelGame(socketId, ws, data) {
    const userId = data.userId;
    const matchId = data.matchId;

    // Find and remove game
    Database.games.forEach((game, gameId) => {
        if (game.creatorId === userId && game.status === 'waiting') {
            // Refund bet
            const user = Database.users.get(userId);
            if (user) {
                user.balance += game.betAmount;

                ws.send(JSON.stringify({
                    type: 'balance',
                    balance: user.balance
                }));
            }

            Database.games.delete(gameId);
            console.log(`Game ${gameId} cancelled by creator`);
        }
    });
}

// Server-authoritative score handling
function handleScoreReport(socketId, ws, data) {
    const gameId = data.gameId;
    const scoredBy = data.scoredBy; // 'player1', 'player2', or 'tie'
    const userId = data.userId;

    const game = Database.games.get(gameId);
    if (!game) return;
    if (game.status !== 'active') {
        console.log(`[SCORE] Ignoring scoreReport for game ${gameId} status=${game.status}`);
        return;
    }
    if (userId !== game.player1Id && userId !== game.player2Id) return;

    // Debounce: ignore duplicate reports within 300ms
    const now = Date.now();
    if (game.lastScoreTime && now - game.lastScoreTime < 300) {
        console.log(`[SCORE] Debounced duplicate score for game ${gameId}`);
        return;
    }
    game.lastScoreTime = now;

    console.log(`[SCORE] Game ${gameId} round ${game.currentRound}: ${scoredBy} scored`);

    if (scoredBy === 'player1') game.score.player1++;
    else if (scoredBy === 'player2') game.score.player2++;

    game.status = 'roundCooldown';
    const COOLDOWN_MS = 3000;

    broadcastToGame(game, {
        type: 'roundCooldown',
        score: { player1: game.score.player1, player2: game.score.player2 },
        roundWinner: scoredBy,
        currentRound: game.currentRound,
        cooldownMs: COOLDOWN_MS,
        serverTime: Date.now()
    });

    const MAX_ROUNDS = 3;
    const gameOver = game.score.player1 >= 2 || game.score.player2 >= 2 || game.currentRound >= MAX_ROUNDS;

    game.roundCooldownTimer = setTimeout(() => {
        game.roundCooldownTimer = null;
        if (gameOver) {
            const winnerId = game.score.player1 > game.score.player2 ? game.player1Id :
                             game.score.player2 > game.score.player1 ? game.player2Id : null;
            endMultiplayerMatch(game, winnerId, 'score');
        } else {
            game.currentRound++;
            game.status = 'active';
            broadcastToGame(game, { type: 'roundResume', currentRound: game.currentRound, serverTime: Date.now() });
        }
    }, COOLDOWN_MS);
}

// End multiplayer match authoritatively
function endMultiplayerMatch(game, winnerId, reason) {
    stopPhysicsLoop(game);
    stopPingLoop(game);
    if (game.roundReadyTimeout) { clearTimeout(game.roundReadyTimeout); game.roundReadyTimeout = null; }
    if (game.roundCooldownTimer) { clearTimeout(game.roundCooldownTimer); game.roundCooldownTimer = null; }
    game.status = 'finished';
    const isTie = !winnerId || winnerId === 'tie';
    const totalPot = game.betAmount * 2;
    const platformFee = isTie ? 0 : totalPot * 0.05;
    const winAmount = isTie ? game.betAmount : totalPot - platformFee;

    const p1 = Database.users.get(game.player1Id);
    const p2 = Database.users.get(game.player2Id);

    let p1EloChange = 0, p2EloChange = 0;

    if (isTie) {
        if (p1) { p1.balance += game.betAmount; p1.matchesPlayed = (p1.matchesPlayed || 0) + 1; }
        if (p2) { p2.balance += game.betAmount; p2.matchesPlayed = (p2.matchesPlayed || 0) + 1; }
    } else {
        const winner = Database.users.get(winnerId);
        const loserId = winnerId === game.player1Id ? game.player2Id : game.player1Id;
        const loser = Database.users.get(loserId);
        if (winner) {
            winner.balance += winAmount;
            winner.wins = (winner.wins || 0) + 1;
            winner.earnings = (winner.earnings || 0) + (winAmount - game.betAmount);
            winner.matchesPlayed = (winner.matchesPlayed || 0) + 1;
        }
        if (loser) {
            loser.losses = (loser.losses || 0) + 1;
            loser.matchesPlayed = (loser.matchesPlayed || 0) + 1;
        }

        // ELO frozen — no changes
        p1EloChange = 0;
        p2EloChange = 0;

        // Referral bonus: 5% of platform fee on referred user's first match
        [game.player1Id, game.player2Id].forEach(pid => {
            const player = Database.users.get(pid);
            if (player && !player.firstMatchDone && player.referredBy) {
                player.firstMatchDone = true;
                const referrer = Database.users.get(player.referredBy);
                if (referrer) {
                    const bonus = platformFee * 0.5; // 50% of fee goes to referrer
                    referrer.balance += bonus;
                    const refSocket = getSocketByUserId(player.referredBy);
                    safeSend(refSocket, {
                        type: 'referralBonus',
                        amount: bonus,
                        fromPlayer: player.name
                    });
                    console.log(`[REFERRAL] Bonus $${bonus.toFixed(2)} paid to ${player.referredBy}`);
                }
            } else if (player && !player.firstMatchDone) {
                player.firstMatchDone = true;
            }
        });
    }

    console.log(`[GAME OVER] Game ${game.id} ended. Winner: ${winnerId || 'tie'}, reason: ${reason}`);

    // Persist both players' updated stats to Supabase
    const _p1 = Database.users.get(game.player1Id);
    const _p2 = Database.users.get(game.player2Id);
    if (_p1) persistUserStats(game.player1Id, _p1);
    if (_p2) persistUserStats(game.player2Id, _p2);

    const p1Socket = getSocketByUserId(game.player1Id);
    const p2Socket = getSocketByUserId(game.player2Id);

    const makeMsg = (playerId) => {
        const player = Database.users.get(playerId);
        const eloChange = playerId === game.player1Id ? p1EloChange : p2EloChange;
        return {
            type: 'gameOver',
            winnerId: winnerId,
            isDraw: isTie,
            score: game.score,
            betAmount: game.betAmount,
            winAmount: winnerId === playerId ? winAmount : 0,
            newBalance: (player || {}).balance || 0,
            matchId: game.id,
            reason: reason,
            eloChange: eloChange,
            newElo: player ? (player.elo || ELO_START) : ELO_START,
            matchesPlayed: player ? (player.matchesPlayed || 0) : 0,
            fairReveal: game.ballSeed !== undefined ? {
                ballSeed: game.ballSeed,
                serverSecret: game.serverSecret,
                commitment: game.fairCommitment
            } : undefined
        };
    };

    safeSend(p1Socket, makeMsg(game.player1Id));
    safeSend(p2Socket, makeMsg(game.player2Id));

    // Broadcast live ticker to all connected clients
    if (!isTie && winner && loser) {
        const s = game.score || { player1: 0, player2: 0 };
        const hi = Math.max(s.player1, s.player2), lo = Math.min(s.player1, s.player2);
        const tickerText = `${winner.name} beat ${loser.name} · $${game.betAmount} · ${hi}-${lo}`;
        Database.activeSockets.forEach(info => safeSend(info.ws, { type: 'tickerUpdate', text: tickerText }));
    }

    // Store rematch metadata
    Database.rematches.set(game.id, {
        player1Id: game.player1Id,
        player2Id: game.player2Id,
        player1Name: game.player1Name,
        player2Name: game.player2Name,
        betAmount: game.betAmount,
        gameMode: game.gameMode || 'classic',
        createdAt: Date.now()
    });

    // Clean up after 5 minutes
    setTimeout(() => Database.rematches.delete(game.id), 300000);

    // Record match in each player's history (last 20 kept)
    const pushHistory = (userId, opponentName, result, netChange, eloCh, myScore, oppScore) => {
        const u = Database.users.get(userId);
        if (!u) return;
        if (!u.matchHistory) u.matchHistory = [];
        u.matchHistory.unshift({
            matchId: game.id,
            opponentName,
            result,
            betAmount: game.betAmount,
            netChange,
            eloChange: eloCh,
            score: `${myScore}-${oppScore}`,
            gameMode: game.gameMode || 'classic',
            timestamp: Date.now()
        });
        if (u.matchHistory.length > 20) u.matchHistory.pop();
    };

    const p1Score = game.score.player1, p2Score = game.score.player2;
    const p1Name = (Database.users.get(game.player1Id) || {}).name || 'Opponent';
    const p2Name = (Database.users.get(game.player2Id) || {}).name || 'Opponent';

    if (isTie) {
        pushHistory(game.player1Id, p2Name, 'draw', 0, 0, p1Score, p2Score);
        pushHistory(game.player2Id, p1Name, 'draw', 0, 0, p2Score, p1Score);
    } else {
        const loserId = winnerId === game.player1Id ? game.player2Id : game.player1Id;
        const winNet  = winAmount - game.betAmount;
        const loseNet = -game.betAmount;
        if (winnerId === game.player1Id) {
            pushHistory(game.player1Id, p2Name, 'win',  winNet,  p1EloChange, p1Score, p2Score);
            pushHistory(game.player2Id, p1Name, 'loss', loseNet, p2EloChange, p2Score, p1Score);
        } else {
            pushHistory(game.player2Id, p1Name, 'win',  winNet,  p2EloChange, p2Score, p1Score);
            pushHistory(game.player1Id, p2Name, 'loss', loseNet, p1EloChange, p1Score, p2Score);
        }
    }

    Database.games.delete(game.id);
}

// Handle rematch request
function handleRematchRequest(socketId, ws, data) {
    const userId = data.userId;
    const matchId = data.matchId;

    const meta = Database.rematches.get(matchId);
    if (!meta) {
        safeSend(ws, { type: 'rematchDeclined', reason: 'Match data expired. Start a new room.' });
        return;
    }

    const opponentId = meta.player1Id === userId ? meta.player2Id : meta.player1Id;
    const opponentName = meta.player1Id === userId ? meta.player2Name : meta.player1Name;
    const requesterName = meta.player1Id === userId ? meta.player1Name : meta.player2Name;
    const opponentSocket = getSocketByUserId(opponentId);

    if (!opponentSocket) {
        safeSend(ws, { type: 'rematchDeclined', reason: 'Opponent is offline.' });
        return;
    }

    const rematchId = generateId();
    const expireTimer = setTimeout(() => {
        Database.rematches.delete(rematchId);
        safeSend(ws, { type: 'rematchExpired' });
        safeSend(getSocketByUserId(opponentId), { type: 'rematchOfferExpired' });
    }, 30000);

    Database.rematches.set(rematchId, {
        requesterId: userId,
        requesterName,
        opponentId,
        opponentName,
        betAmount: meta.betAmount,
        gameMode: meta.gameMode,
        expireTimer,
        matchId
    });

    safeSend(ws, { type: 'rematchSent', rematchId });
    safeSend(opponentSocket, {
        type: 'rematchOffer',
        rematchId,
        requesterId: userId,
        requesterName,
        betAmount: meta.betAmount,
        gameMode: meta.gameMode
    });

    console.log(`[REMATCH] ${userId} sent rematch offer ${rematchId} to ${opponentId}`);
}

// Accept rematch offer
function handleRematchAccept(_socketId, ws, data) {
    const { userId, rematchId } = data;
    const meta = Database.rematches.get(rematchId);
    if (!meta || meta.opponentId !== userId) {
        safeSend(ws, { type: 'error', message: 'Rematch offer expired or invalid.' });
        return;
    }

    clearTimeout(meta.expireTimer);
    Database.rematches.delete(rematchId);

    // Deduct bets from both players
    const requester = Database.users.get(meta.requesterId);
    const accepter = Database.users.get(userId);
    if (!requester || !accepter) {
        safeSend(ws, { type: 'error', message: 'Player data not found.' });
        return;
    }
    if (requester.balance < meta.betAmount || accepter.balance < meta.betAmount) {
        safeSend(ws, { type: 'error', message: 'Insufficient balance for rematch.' });
        safeSend(getSocketByUserId(meta.requesterId), { type: 'rematchDeclined', reason: 'Insufficient balance.' });
        return;
    }

    requester.balance -= meta.betAmount;
    accepter.balance -= meta.betAmount;

    const newGameId = generateId();
    const game = {
        id: newGameId,
        creatorId: meta.requesterId,
        player1Id: meta.requesterId,
        player1Name: meta.requesterName,
        player2Id: userId,
        player2Name: meta.opponentName,
        betAmount: meta.betAmount,
        gameMode: meta.gameMode,
        status: 'readyCheck',
        score: { player1: 0, player2: 0 },
        currentRound: 1,
        ballSeed: Math.floor(Math.random() * 2147483647),
        roundCooldownTimer: null,
        lastScoreTime: 0
    };
    Database.games.set(newGameId, game);

    const gameData = {
        id: game.id, player1Id: game.player1Id, player1Name: game.player1Name,
        player2Id: game.player2Id, player2Name: game.player2Name,
        betAmount: game.betAmount, gameMode: game.gameMode, isAIGame: false,
        ballSeed: game.ballSeed
    };

    const rSock = getSocketByUserId(meta.requesterId);
    safeSend(rSock, { type: 'matchReady', game: gameData, youAre: 'player1',
        newBalance: requester.balance });
    safeSend(ws, { type: 'matchReady', game: gameData, youAre: 'player2',
        newBalance: accepter.balance });

    console.log(`[REMATCH] Accepted: ${newGameId}`);
}

// Decline rematch offer
function handleRematchDecline(_socketId, _ws, data) {
    const { rematchId } = data;
    const meta = Database.rematches.get(rematchId);
    if (!meta) return;

    clearTimeout(meta.expireTimer);
    Database.rematches.delete(rematchId);

    const requesterSocket = getSocketByUserId(meta.requesterId);
    safeSend(requesterSocket, { type: 'rematchDeclined', reason: 'Opponent declined.' });
    console.log(`[REMATCH] Declined: ${rematchId}`);
}

// Handle report submission
function handleSubmitReport(socketId, ws, data) {
    const report = {
        userId: data.userId,
        matchId: data.matchId,
        description: data.description,
        timestamp: data.timestamp,
        id: generateId()
    };

    Database.reports.push(report);

    console.log(`📝 Report submitted by user ${data.userId}: ${data.description}`);

    ws.send(JSON.stringify({
        type: 'info',
        message: 'Report submitted successfully'
    }));
}

// Handle admin ban
function handleAdminBan(socketId, ws, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    const adminId = socketInfo.userId;

    if (!ADMIN_IDS.has(String(adminId))) {
        console.warn(`[SECURITY] Non-admin ${adminId} tried to ban ${data.identifier} — blocked`);
        safeSend(ws, { type: 'error', message: 'Unauthorized' });
        return;
    }

    const identifier = data.identifier;
    const reason = data.reason;

    Database.bans.set(identifier, {
        reason: reason,
        bannedBy: adminId,
        timestamp: data.timestamp
    });

    console.log(`🔨 User/IP ${identifier} banned by ${adminId}: ${reason}`);

    // Find and disconnect banned user
    Database.users.forEach((user, userId) => {
        if (userId.toString() === identifier) {
            const socket = getSocketByUserId(userId);
            if (socket) {
                socket.send(JSON.stringify({
                    type: 'banned',
                    reason: reason
                }));
                socket.close();
            }
        }
    });
}

// Handle game timeout
function handleGameTimeout(socketId, ws, data) {
    const gameId = data.gameId;
    const winnerId = data.winnerId;

    const game = Database.games.get(gameId);
    if (!game) return;

    if (winnerId) {
        // Someone was ahead when time ran out
        endGame(game);
    } else {
        // Tie - return bets
        const player1 = Database.users.get(game.player1Id);
        const player2 = Database.users.get(game.player2Id);

        if (player1) player1.balance += game.betAmount;
        if (player2) player2.balance += game.betAmount;

        // Notify both players
        const player1Socket = getSocketByUserId(game.player1Id);
        const player2Socket = getSocketByUserId(game.player2Id);

        const tieMessage = {
            type: 'gameTied',
            betAmount: game.betAmount,
            newBalance: player1 ? player1.balance : 0
        };

        if (player1Socket) {
            tieMessage.newBalance = player1.balance;
            player1Socket.send(JSON.stringify(tieMessage));
        }
        if (player2Socket) {
            tieMessage.newBalance = player2.balance;
            player2Socket.send(JSON.stringify(tieMessage));
        }

        Database.games.delete(gameId);
        console.log(`Game ${gameId} ended in tie - bets returned`);
    }
}

// Generate unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// ── Global Chat ───────────────────────────────────────────────────────────────
const chatHistory = [];
const chatRateLimit = new Map(); // userId -> lastMessageTime

function handleChatMessage(socketId, ws, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    const userId = socketInfo.userId;
    const user = Database.users.get(userId);
    if (!user) return;

    if ((user.totalWagered || 0) < 15) {
        safeSend(ws, { type: 'chatError', message: `Chat unlocks after wagering $15 total. You've wagered $${(user.totalWagered||0).toFixed(2)}.` });
        return;
    }

    const now = Date.now();
    if (now - (chatRateLimit.get(userId) || 0) < 2000) return;
    chatRateLimit.set(userId, now);

    const text = String(data.text || '').slice(0, 120).trim();
    if (!text) return;

    const msg = { username: user.name, text, t: now };
    chatHistory.push(msg);
    if (chatHistory.length > 50) chatHistory.shift();

    Database.activeSockets.forEach(info => {
        if (info.ws && info.ws.readyState === 1) safeSend(info.ws, { type: 'chatMessage', ...msg });
    });
}

function handleGetChat(socketId, ws) {
    safeSend(ws, { type: 'chatHistory', messages: chatHistory });
}

// ── Gift Credits ──────────────────────────────────────────────────────────────
function handleGiftCredits(socketId, ws, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    const senderId = socketInfo.userId;
    const sender = Database.users.get(senderId);
    const amount = parseFloat(data.amount);
    const recipientName = String(data.toName || data.recipientName || '').trim();

    if (!sender || isNaN(amount) || amount <= 0) return;

    const fee = parseFloat((amount * 0.005).toFixed(4));
    const totalDeduct = amount + fee;

    if (sender.balance < totalDeduct) {
        safeSend(ws, { type: 'error', message: 'Insufficient balance to send gift.' });
        return;
    }

    let recipient = null, recipientId = null;
    Database.users.forEach((u, id) => {
        if (u.name === recipientName) { recipient = u; recipientId = id; }
    });

    if (!recipient) { safeSend(ws, { type: 'error', message: 'Player not found or offline.' }); return; }
    if (recipientId === senderId) { safeSend(ws, { type: 'error', message: 'Cannot gift yourself.' }); return; }

    sender.balance -= totalDeduct;
    recipient.balance += amount;

    safeSend(ws, { type: 'balance', balance: sender.balance });
    safeSend(ws, { type: 'giftSent', amount, amountDeducted: totalDeduct, to: recipientName, fee });
    const recipSock = getSocketByUserId(recipientId);
    safeSend(recipSock, { type: 'giftReceived', amount, fromName: sender.name, from: sender.name });
    safeSend(recipSock, { type: 'balance', balance: recipient.balance });

    persistUserStats(senderId, sender);
    persistUserStats(recipientId, recipient);
    console.log(`[GIFT] ${sender.name} gifted $${amount} to ${recipientName} (fee $${fee})`);
}

// ── Double or Nothing ─────────────────────────────────────────────────────────
const doubleOffers = new Map(); // offerId -> { requesterId, opponentId, betAmount, matchId, timer }

function handleDoubleOrNothing(socketId, ws, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    const requesterId = socketInfo.userId;
    const meta = Database.rematches.get(data.matchId);
    if (!meta) { safeSend(ws, { type: 'error', message: 'Match data expired.' }); return; }

    const requester = Database.users.get(requesterId);
    const opponentId = meta.player1Id === requesterId ? meta.player2Id : meta.player1Id;
    const doubleBet = meta.betAmount * 2;

    if (!requester || requester.balance < doubleBet) {
        safeSend(ws, { type: 'error', message: `Need $${doubleBet.toFixed(2)} to double or nothing.` }); return;
    }

    const offerId = generateId();
    const timer = setTimeout(() => {
        doubleOffers.delete(offerId);
        safeSend(ws, { type: 'doubleOrNothingExpired' });
    }, 20000);

    doubleOffers.set(offerId, { requesterId, opponentId, betAmount: doubleBet,
        gameMode: meta.gameMode, requesterName: requester.name,
        opponentName: meta.player1Id === requesterId ? meta.player2Name : meta.player1Name, timer });

    safeSend(ws, { type: 'doubleOrNothingSent' });
    const oppSock = getSocketByUserId(opponentId);
    safeSend(oppSock, { type: 'doubleOrNothingOffer', offerId,
        fromName: requester.name, betAmount: doubleBet });
}

function handleDoubleOrNothingAccept(socketId, ws, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    const accepterId = socketInfo.userId;
    const offer = doubleOffers.get(data.offerId);
    if (!offer) { safeSend(ws, { type: 'error', message: 'Offer expired.' }); return; }

    clearTimeout(offer.timer);
    doubleOffers.delete(data.offerId);

    const requester = Database.users.get(offer.requesterId);
    const accepter = Database.users.get(accepterId);
    if (!requester || !accepter) return;
    if (requester.balance < offer.betAmount || accepter.balance < offer.betAmount) {
        safeSend(ws, { type: 'error', message: 'Insufficient balance.' });
        safeSend(getSocketByUserId(offer.requesterId), { type: 'error', message: 'Opponent cannot cover the bet.' });
        return;
    }

    requester.balance -= offer.betAmount;
    accepter.balance  -= offer.betAmount;
    requester.totalWagered = (requester.totalWagered || 0) + offer.betAmount;
    accepter.totalWagered  = (accepter.totalWagered  || 0) + offer.betAmount;

    const newGameId = generateId();
    const game = {
        id: newGameId, creatorId: offer.requesterId,
        player1Id: offer.requesterId, player1Name: offer.requesterName,
        player2Id: accepterId, player2Name: offer.opponentName,
        betAmount: offer.betAmount, gameMode: offer.gameMode,
        status: 'readyCheck', score: { player1: 0, player2: 0 },
        currentRound: 1, ballSeed: Math.floor(Math.random() * 2147483647),
        roundCooldownTimer: null, lastScoreTime: 0
    };
    Database.games.set(newGameId, game);

    const gameData = { id: game.id, player1Id: game.player1Id, player1Name: game.player1Name,
        player2Id: game.player2Id, player2Name: game.player2Name,
        betAmount: game.betAmount, gameMode: game.gameMode, isAIGame: false, ballSeed: game.ballSeed };

    safeSend(getSocketByUserId(offer.requesterId), { type: 'matchReady', game: gameData, youAre: 'player1', newBalance: requester.balance });
    safeSend(ws, { type: 'matchReady', game: gameData, youAre: 'player2', newBalance: accepter.balance });
    console.log(`[DOUBLE] Double-or-nothing game ${newGameId} started at $${offer.betAmount}`);
}

function handleDoubleOrNothingDecline(socketId, ws, data) {
    const offer = doubleOffers.get(data.offerId);
    if (!offer) return;
    clearTimeout(offer.timer);
    doubleOffers.delete(data.offerId);
    safeSend(getSocketByUserId(offer.requesterId), { type: 'doubleOrNothingDeclined' });
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ WebSocket server ready on port ${PORT}`);
    console.log(`✅ Listening on all interfaces (0.0.0.0)`);
    console.log(`✅ Anti-cheat system active`);
});
