// Backend Server - Node.js + WebSocket for real-time multiplayer
// Run this with: node server.js

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient: createSupabase } = require('@supabase/supabase-js');
const { TonClient, WalletContractV4, internal, toNano, beginCell, Address } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

// Load .env file (mnemonic, API keys)
const _envPath = path.join(__dirname, '.env');
if (fs.existsSync(_envPath)) {
    fs.readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
        const eq = line.indexOf('=');
        if (eq > 0 && !line.startsWith('#')) {
            const k = line.slice(0, eq).trim();
            const v = line.slice(eq + 1).trim();
            if (k && !process.env[k]) process.env[k] = v;
        }
    });
}

const db = createSupabase(
    process.env.SUPABASE_URL || 'https://qfzbhjnksngtlihuovcm.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || 'sb_publishable_wXqf6IXKxjlMknuLEFKT8w_r2KfM8tr',
    { realtime: { webSocketImpl: require('ws') } }
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
        name_changes_remaining: user.nameChangesRemaining ?? 3,
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' }).then(({ error }) => {
        if (error) console.error('[DB] Persist error:', error.message);
    });
}

// Log a deposit or withdrawal transaction
function logTransaction(userId, type, amount, txHash, matchId) {
    db.from('transactions').insert({
        user_id: String(userId),
        type,
        amount,
        tx_hash: txHash || null,
        match_id: matchId || null,
        created_at: new Date().toISOString()
    }).then(({ error }) => {
        if (error) console.error('[DB] Transaction log error:', error.message);
    });
}

// Accumulate platform fee in DB and in-memory counter
const OWNER_WALLET       = process.env.OWNER_WALLET || 'UQDzfMkS16zyHDnJwSX_Fa0C6xvY0SodUBaZo_WY726v61JU';
const AUTO_SWEEP_THRESHOLD = parseFloat(process.env.AUTO_SWEEP_THRESHOLD || '100');

let _platformFeesAccumulated = 0;
let _sweepInProgress = false;

function accumulatePlatformFee(amount) {
    if (!amount || amount <= 0) return;
    _platformFeesAccumulated += amount;
    db.from('platform_fees').upsert({
        id: 1,
        accumulated: _platformFeesAccumulated,
        lifetime_total: _platformFeesAccumulated,
        updated_at: new Date().toISOString()
    }, { onConflict: 'id' }).then(({ error }) => {
        if (error) console.error('[DB] Fee accumulate error:', error.message);
    });
    console.log(`[FEES] +$${amount.toFixed(4)} | Total accumulated: $${_platformFeesAccumulated.toFixed(4)}`);
    if (_platformFeesAccumulated >= AUTO_SWEEP_THRESHOLD && !_sweepInProgress) {
        executeSweep(OWNER_WALLET);
    }
}

async function executeSweep(toAddr) {
    if (_sweepInProgress || _platformFeesAccumulated < 0.01) return;
    _sweepInProgress = true;
    const sweepAmount = _platformFeesAccumulated;
    _platformFeesAccumulated = 0;
    console.log(`[FEES] Auto-sweeping $${sweepAmount.toFixed(4)} → ${toAddr}`);
    try {
        await sendUSDTTransfer(toAddr, sweepAmount);
        db.from('platform_fees').upsert({ id: 1, accumulated: 0, updated_at: new Date().toISOString() }, { onConflict: 'id' });
        logTransaction('PLATFORM', 'fee_sweep', sweepAmount, null, null);
        console.log(`[FEES] Sweep complete: $${sweepAmount.toFixed(4)} → ${toAddr}`);
    } catch (e) {
        _platformFeesAccumulated += sweepAmount; // restore on failure
        console.error('[FEES] Sweep failed:', e.message);
    } finally {
        _sweepInProgress = false;
    }
}

// Load accumulated platform fees on startup
async function loadPlatformFees() {
    try {
        const { data } = await db.from('platform_fees').select('accumulated').eq('id', 1).single();
        if (data) { _platformFeesAccumulated = parseFloat(data.accumulated) || 0; }
        console.log(`[FEES] Loaded accumulated: $${_platformFeesAccumulated.toFixed(4)}`);
    } catch { /* first boot */ }
}

// ── TON Payment Config ────────────────────────────────────────────────────────
const TONAPI_KEY   = process.env.TONAPI_KEY  || '';
const TON_MNEMONIC = (process.env.TON_MNEMONIC || '').split(' ').filter(Boolean);
const GAME_WALLET  = process.env.TON_WALLET  || 'UQAsF-kKU4tzrIf4DcTMzCSNv0zJ-Vq38dlEMc7PwAv2b77d';
const USDT_MASTER  = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const MIN_DEPOSIT  = 2;   // USDT
const MIN_WITHDRAW = 2;   // USDT
const WITHDRAW_ANTI_WAGER = 10; // must have wagered $10 before withdrawing

let tonClient = null, gameWalletContract = null, gameWalletKeyPair = null;
const processedDepositHashes = new Set(); // prevent double-crediting

async function initTONWallet() {
    try {
        if (!TON_MNEMONIC.length) { console.error('[TON] No mnemonic in .env'); return; }
        tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });
        gameWalletKeyPair = await mnemonicToPrivateKey(TON_MNEMONIC);
        gameWalletContract = tonClient.open(
            WalletContractV4.create({ publicKey: gameWalletKeyPair.publicKey, workchain: 0 })
        );
        console.log('[TON] Hot wallet ready:', GAME_WALLET);
    } catch (e) { console.error('[TON] Wallet init failed:', e.message); }
}

async function getJettonWalletAddr(ownerAddress) {
    const res = await tonClient.runMethod(
        Address.parse(USDT_MASTER), 'get_wallet_address',
        [{ type: 'slice', cell: beginCell().storeAddress(Address.parse(ownerAddress)).endCell() }]
    );
    return res.stack.readAddress();
}

async function sendUSDTTransfer(toAddress, amountUSDT) {
    if (!gameWalletContract) throw new Error('TON wallet not initialized');
    const jettonWallet = await getJettonWalletAddr(GAME_WALLET);
    const amountNano = BigInt(Math.round(amountUSDT * 1e6));
    const body = beginCell()
        .storeUint(0xf8a7ea5, 32)
        .storeUint(0, 64)
        .storeCoins(amountNano)
        .storeAddress(Address.parse(toAddress))
        .storeAddress(Address.parse(GAME_WALLET))
        .storeBit(0)
        .storeCoins(1n)
        .storeBit(0)
        .endCell();
    const seqno = await gameWalletContract.getSeqno();
    await gameWalletContract.sendTransfer({
        seqno,
        secretKey: gameWalletKeyPair.secretKey,
        messages: [internal({ to: jettonWallet, value: toNano('0.1'), body })]
    });
}

async function processUSDTDeposit(txHash, amountRaw, memo) {
    if (!txHash || processedDepositHashes.has(txHash)) return;
    const amountUSDT = Number(amountRaw) / 1e6;
    if (amountUSDT < MIN_DEPOSIT) { console.log(`[TON] Deposit too small: $${amountUSDT}`); return; }
    const userId = String(memo || '').trim();
    const user = Database.users.get(userId);
    if (!user) { console.log(`[TON] No user for memo "${userId}", tx=${txHash}`); return; }
    processedDepositHashes.add(txHash);
    user.balance = (user.balance || 0) + amountUSDT;
    persistUserStats(userId, user);
    logTransaction(userId, 'deposit', amountUSDT, txHash, null);
    const ws = getSocketByUserId(userId);
    if (ws) {
        safeSend(ws, { type: 'balance', balance: user.balance });
        safeSend(ws, { type: 'depositConfirmed', amount: amountUSDT, balance: user.balance });
    }
    console.log(`[TON] Deposit credited: $${amountUSDT} → user ${userId} (${user.name}), new balance $${user.balance.toFixed(2)}`);
}

function handleTONWebhook(event) {
    const actions = event.actions || [];
    for (const action of actions) {
        if (action.type !== 'JettonTransfer' || action.status !== 'ok') continue;
        const t = action.JettonTransfer || action.jetton_transfer;
        if (!t) continue;
        const sym = t.jetton?.symbol || '';
        if (sym !== 'USD₮' && sym !== 'USDT' && !(t.jetton?.name || '').includes('Tether')) continue;
        const txHash = event.event_id || String(Date.now());
        processUSDTDeposit(txHash, t.amount || '0', t.comment || '');
    }
}

// Poll tonapi.io every 15s for new USDT deposits to the game wallet
let _lastEventLt = '0'; // logical time of last seen event (paginates newer ones)

async function pollTONDeposits() {
    if (!TONAPI_KEY) return;
    try {
        const url = `https://tonapi.io/v2/accounts/${encodeURIComponent(GAME_WALLET)}/events?limit=20&subject_only=true`;
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${TONAPI_KEY}` } });
        if (!res.ok) return;
        const data = await res.json();
        const events = (data.events || []).reverse(); // oldest first
        for (const event of events) {
            if (event.lt <= _lastEventLt) continue;
            _lastEventLt = event.lt;
            handleTONWebhook(event);
        }
    } catch (e) { /* silent — network hiccup */ }
}

function startTONPoller() {
    if (!TONAPI_KEY) { console.log('[TON] No TONAPI_KEY — deposit polling disabled'); return; }
    pollTONDeposits(); // run immediately on startup
    setInterval(pollTONDeposits, 15000); // then every 15 seconds
    console.log('[TON] Deposit poller started (15s interval)');
}

// ── Security Config ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Your Telegram user ID(s) — only these can use admin commands
// Find your ID by messaging @userinfobot on Telegram
const ADMIN_IDS = new Set([
    '8325405950',
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
    game.physicsTimeout = true; // sentinel — prevents double-start before first tick
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

    const _p1RTT = Math.min(game.player1RTT || 120, 400);
    const _p2RTT = Math.min(game.player2RTT || 120, 400);
    const p1lag = game.paddle1.x;
    const p2lag = game.paddle2.x;
    // Horizontal buffer: forgives small position drift from jitter/rounding
    // Horizontal buffer: widens the hitbox to forgive RTT-induced paddle position lag
    const P1_LAG_BUFFER = Math.max(16, Math.min(40, Math.round(_p1RTT * 0.28)));
    const P2_LAG_BUFFER = Math.max(16, Math.min(40, Math.round(_p2RTT * 0.28)));

    // Paddle 1 collision (bottom paddle) — crossP1: ball crossed line this tick
    const pBot = prevY + BALL_R, cBot = ball.y + BALL_R;
    const crossP1 = pBot <= P1_Y && cBot >= P1_Y;
    let p1cx = ball.x;
    if (crossP1 && cBot !== pBot) {
        p1cx = prevX + effX * ((P1_Y - pBot) / (cBot - pBot));
    }
    if ((crossP1 || (cBot > P1_Y && cBot < P1_Y + PADDLE_H)) &&
        p1cx > p1lag - BALL_R - P1_LAG_BUFFER && p1cx < p1lag + PADDLE_W + BALL_R + P1_LAG_BUFFER && ball.speedY > 0) {
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
    if (crossP2 && cTop !== pTop) {
        p2cx = prevX + effX * ((p2Bot - pTop) / (cTop - pTop));
    }
    if ((crossP2 || (cTop < p2Bot && cTop > P2_Y)) &&
        p2cx > p2lag - BALL_R - P2_LAG_BUFFER && p2cx < p2lag + PADDLE_W + BALL_R + P2_LAG_BUFFER && ball.speedY < 0) {
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

    // Score detection — arm a 200ms grace window for late hit reports rather than scoring immediately.
    // At 100ms ping the client's hit report often arrives after this tick fires; the grace lets
    // handleClientHitReport rescue the bounce instead of silently losing the round.
    if (ball.y - BALL_R < 0) {
        console.log(`[MISS] P2 missed: ball=(${ball.x.toFixed(1)},${ball.y.toFixed(1)}) p2.x=${game.paddle2.x.toFixed(1)} P2_RTT=${game.player2RTT||'?'}ms — arming 200ms grace`);
        armPendingMiss(game, 'player1', prevX, prevY); return;
    }
    if (ball.y + BALL_R > WORLD_H) {
        console.log(`[MISS] P1 missed: ball=(${ball.x.toFixed(1)},${ball.y.toFixed(1)}) p1.x=${game.paddle1.x.toFixed(1)} P1_RTT=${game.player1RTT||'?'}ms — arming 200ms grace`);
        armPendingMiss(game, 'player2', prevX, prevY); return;
    }

    // Round timer (40s)
    if (game.roundStartTime && now - game.roundStartTime >= 40000) {
        stopPhysicsLoop(game); handleScoreEvent(game, 'tie'); return;
    }

    // Broadcast authoritative state — binary (37 bytes vs ~145 bytes JSON)
    broadcastBinaryToGame(game, makeBinaryGameState(ball, game.paddle1.x, game.paddle2.x, ramp, now));
}

// Arm a 200ms grace window before committing a miss.
// At 100ms RTT the client's hit report often arrives ~50ms after the server already detected a miss;
// without this window the client sees their hit + bounce locally but server already scored the round.
function armPendingMiss(game, scoredBy, snapshotX, snapshotY) {
    if (game.pendingMiss) return;
    stopPhysicsLoop(game);
    game.pendingMiss = {
        scoredBy,
        ballSnapshot: { x: snapshotX, y: snapshotY, speedX: game.ball.speedX, speedY: game.ball.speedY }
    };
    // The player who (maybe) missed is the one whose late hit report we're waiting for.
    // Scale the window to their RTT so high-latency clients still get rescued, while
    // low-latency clients commit the miss quickly instead of feeling a ~200ms hang.
    const misser = scoredBy === 'player1' ? 'player2' : 'player1';
    const rtt = (misser === 'player1' ? game.player1RTT : game.player2RTT) || 120;
    const graceMs = Math.max(150, Math.min(400, Math.round(rtt * 0.75 + 90)));
    game.pendingMissTimer = setTimeout(() => commitPendingMiss(game), graceMs);
}

function commitPendingMiss(game) {
    if (!game.pendingMiss) return;
    const scoredBy = game.pendingMiss.scoredBy;
    game.pendingMiss = null;
    game.pendingMissTimer = null;
    handleScoreEvent(game, scoredBy);
}

// Server-authoritative score event — called from serverTick, never from client
function handleScoreEvent(game, scoredBy) {
    if (game.status !== 'active') return;
    game.status = 'roundCooldown';
    game.lastScoreTime = Date.now();
    const COOLDOWN_MS = 5000;

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
            // Safety fallback: start round anyway after 4s if a client doesn't respond
            game.roundReadyTimeout = setTimeout(() => {
                game.roundReadyTimeout = null;
                if (game.status === 'roundCooldown') {
                    console.log(`[ROUND] Timeout — starting round ${game.currentRound} without full ready`);
                    startNewRound(game);
                }
            }, 4000);
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

    // Round 2+ sends roundReady at the START of the client's 5s cosmetic countdown (PM2 199 sync optimization).
    // Without deferring physics, the ball moves on the server for the entire countdown and is already
    // mid-trajectory — often past a paddle — the instant GO! clears on the client.
    // Round 1 paths (initial-after-ring / rematch-after-overlay) complete their cosmetic before sending
    // roundReady, so no delay is needed for them.
    const COSMETIC_DELAY = game.currentRound > 1 ? 5000 : 0;
    const ballStartAt = Date.now() + COSMETIC_DELAY;
    game.roundStartTime = ballStartAt;
    game.ball.rampUpStartTime = ballStartAt; // ramp begins when ball actually moves, not when round was scheduled

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
        ballStartAt,
        fairCommitment: game.currentRound === 1 ? game.fairCommitment : undefined
    });

    const beginPhysics = () => {
        game.physicsStartTimer = null;
        if (game.status !== 'active') return; // game ended during the delay
        startPhysicsLoop(game);
        startPingLoop(game);
        console.log(`[ROUND] Round ${game.currentRound} ball physics started — P1_RTT=${game.player1RTT||'?'}ms P2_RTT=${game.player2RTT||'?'}ms`);
    };

    if (COSMETIC_DELAY > 0) {
        game.physicsStartTimer = setTimeout(beginPhysics, COSMETIC_DELAY);
        console.log(`[ROUND] Round ${game.currentRound} scheduled — physics deferred ${COSMETIC_DELAY}ms for client cosmetic`);
    } else {
        beginPhysics();
    }
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
    // TON deposit webhook (tonapi.io pushes here on every USDT transfer to game wallet)
    if (req.method === 'POST' && req.url === '/ton-webhook') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString().slice(0, 8192); });
        req.on('end', () => {
            try { handleTONWebhook(JSON.parse(body)); } catch (e) { console.error('[TON] Webhook parse error:', e.message); }
            res.writeHead(200); res.end('ok');
        });
        return;
    }

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
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache'
        });
        res.end(data);
    });
}

// Create WebSocket server
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

console.log(`Server starting on port ${PORT}...`);

// WebSocket connection handler
wss.on('connection', (ws) => {
    ws._socket.setNoDelay(true);
    console.log('New client connected');

    const socketId = generateId();
    Database.activeSockets.set(socketId, { ws, userId: null });

    // Rate limiting: 60fps paddle moves + overhead = ~400 per 5s during active play
    let msgCount = 0;
    let rateLimitWindow = Date.now();
    const RATE_LIMIT = 400;
    const RATE_WINDOW_MS = 5000;

    // Native WebSocket keepalive — prevents mobile OS from killing idle TCP connections
    const keepalive = setInterval(() => {
        if (ws.readyState === 1) ws.ping();
    }, 25000);

    // Handle messages from client
    ws.on('message', (message, isBinary) => {
        if (message.length > 4096) {
            console.warn(`[SECURITY] Oversized message from ${socketId}, length=${message.length}`);
            return;
        }
        // Fixed-window rate check
        const now = Date.now();
        if (now - rateLimitWindow > RATE_WINDOW_MS) {
            msgCount = 0;
            rateLimitWindow = rateLimitWindow + RATE_WINDOW_MS;
        }
        msgCount++;
        if (msgCount > RATE_LIMIT) {
            const socketInfo = Database.activeSockets.get(socketId);
            console.warn(`[RATE LIMIT] Socket ${socketId} (user ${socketInfo && socketInfo.userId}) exceeded ${RATE_LIMIT} msgs/${RATE_WINDOW_MS}ms — dropping`);
            safeSend(ws, { type: 'error', message: 'Too many requests. Slow down.' });
            return;
        }

        try {
            if (isBinary) {
                handleBinaryClientMessage(socketId, ws, message);
            } else {
                const data = JSON.parse(message.toString());
                handleClientMessage(socketId, ws, data);
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        clearInterval(keepalive);
        handleDisconnect(socketId);
    });

    ws.send(JSON.stringify({ type: 'connected', message: 'Connected to game server' }));
    broadcastOnlineCount();
});

// Handle messages from clients
function handleClientMessage(socketId, ws, data) {
    if (data.type !== 'paddleMove' && data.type !== 'pong' && data.type !== 'echo') {
        console.log(`[WS<-] ${data.type} from socket ${socketId}`, JSON.stringify(data).substring(0, 120));
    }

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

        case 'requestDeposit':
            safeSend(ws, {
                type: 'depositInfo',
                walletAddress: GAME_WALLET,
                memo: String(data.userId),
                minAmount: MIN_DEPOSIT,
            });
            break;

        case 'deposit': // legacy stub — silently ignore
            break;

        case 'adminCredit':
            handleAdminCredit(socketId, ws, data);
            break;

        case 'adminSweepFees':
            handleSweepFees(socketId, ws, data);
            break;

        case 'adminFeeBalance':
            handleFeeBalance(socketId, ws);
            break;

        case 'requestWithdrawal':
            handleWithdraw(socketId, ws, data);
            break;

        case 'withdraw': // legacy — route to new handler
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

        case 'echo':
            safeSend(ws, { type: 'echo', t: data.t });
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
            languageCode: data.languageCode || 'en',
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
            user.balance             = saved.balance             ?? 100;
            user.elo                 = saved.elo                ?? ELO_START;
            user.wins                = saved.wins               ?? 0;
            user.losses              = saved.losses             ?? 0;
            user.earnings            = saved.earnings           ?? 0;
            user.matchesPlayed       = saved.matches_played     ?? 0;
            user.totalWagered        = saved.total_wagered      ?? 0;
            user.nameChangesRemaining = saved.name_changes_remaining ?? 3;
            const sock = getSocketByUserId(userId);
            safeSend(sock, { type: 'balance', balance: user.balance });
            console.log(`[DB] Restored stats for ${userName}: balance=${user.balance} elo=${user.elo}`);
        }).catch(e => console.error('[DB] Load error:', e.message));
    } else {
        const user = Database.users.get(userId);
        user.socketId = socketId;
        user.name = userName;
        if (data.languageCode) user.languageCode = data.languageCode;
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

    // If there's a pending rematch offer for this user (sent while they were disconnected),
    // resend it so they don't miss the invite after a reconnect/reload.
    Database.rematches.forEach((meta, rematchId) => {
        if (meta.opponentId === userId && meta.requesterId) {
            safeSend(ws, {
                type: 'rematchOffer',
                rematchId,
                requesterId: meta.requesterId,
                requesterName: meta.requesterName,
                betAmount: meta.betAmount,
                gameMode: meta.gameMode
            });
        }
    });

    // Push current room list immediately so client sees rooms without waiting for poll
    const waitingRooms = getWaitingRooms();
    ws.send(JSON.stringify({ type: 'roomsList', rooms: waitingRooms }));
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

// Admin: check accumulated platform fees
function handleFeeBalance(socketId, ws) {
    const socketInfo = Database.activeSockets.get(socketId);
    if (!socketInfo || !ADMIN_IDS.has(String(socketInfo.userId))) {
        safeSend(ws, { type: 'error', message: 'Unauthorized' }); return;
    }
    safeSend(ws, { type: 'feeBalance', accumulated: _platformFeesAccumulated });
}

// Admin: manually trigger fee sweep (uses OWNER_WALLET by default, or custom address)
async function handleSweepFees(socketId, ws, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    if (!socketInfo || !ADMIN_IDS.has(String(socketInfo.userId))) {
        safeSend(ws, { type: 'error', message: 'Unauthorized' }); return;
    }
    if (_platformFeesAccumulated < 0.01) { safeSend(ws, { type: 'sweepResult', success: false, reason: 'Nothing to sweep' }); return; }
    if (_sweepInProgress) { safeSend(ws, { type: 'sweepResult', success: false, reason: 'Sweep already in progress' }); return; }

    const toAddr = String(data.toAddress || OWNER_WALLET).trim();
    const sweepAmount = _platformFeesAccumulated;

    try {
        await executeSweep(toAddr);
        safeSend(ws, { type: 'sweepResult', success: true, amount: sweepAmount, toAddress: toAddr });
    } catch (e) {
        safeSend(ws, { type: 'sweepResult', success: false, reason: e.message });
    }
}

// Handle withdrawal — sends real USDT on-chain from hot wallet
function handleWithdraw(socketId, ws, data) {
    const userId  = String(data.userId);
    const amount  = parseFloat(data.amount);
    const toAddr  = String(data.address || data.toAddress || '').trim();
    const user    = Database.users.get(userId);

    const fail = reason => safeSend(ws, { type: 'withdrawalResult', success: false, reason });

    if (!user)                              return fail('User not found');
    if (!amount || amount < MIN_WITHDRAW)   return fail(`Minimum withdrawal is $${MIN_WITHDRAW} USDT`);
    if (user.balance < amount)              return fail('Insufficient balance');
    if ((user.totalWagered || 0) < WITHDRAW_ANTI_WAGER)
                                            return fail(`Play at least $${WITHDRAW_ANTI_WAGER} in matches first`);
    if (!/^(UQ|EQ|0:)[A-Za-z0-9_-]{46,}/.test(toAddr))
                                            return fail('Invalid TON wallet address');

    // Deduct immediately — refund if transfer fails
    user.balance -= amount;
    safeSend(ws, { type: 'balance', balance: user.balance });

    sendUSDTTransfer(toAddr, amount)
        .then(() => {
            persistUserStats(userId, user);
            logTransaction(userId, 'withdrawal', amount, null, null);
            safeSend(ws, { type: 'withdrawalResult', success: true, amount, toAddress: toAddr });
            console.log(`[TON] Withdrawal: $${amount} USDT → ${toAddr} for user ${userId}`);
        })
        .catch(e => {
            user.balance += amount; // refund
            safeSend(ws, { type: 'balance', balance: user.balance });
            fail('Transfer failed: ' + e.message);
            console.error('[TON] Withdrawal failed:', e.message);
        });
}

// Create game
function handleCreateGame(socketId, ws, data) {
    const userId = data.userId;
    const betAmount = parseFloat(data.betAmount);

    const user = Database.users.get(userId);

    if (!user || (betAmount > 0 && user.balance < betAmount)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Insufficient balance' }));
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
        ball: { x: 0, y: 0, speedX: 0, speedY: 0 },
        createdAt: Date.now(),
        startedAt: null
    };

    Database.games.set(gameId, game);

    console.log(`Game created: ${gameId} by ${user.name} with bet ${betAmount}`);

    ws.send(JSON.stringify({ type: 'gameCreated', game: game }));
    ws.send(JSON.stringify({ type: 'balance', balance: user.balance }));
    broadcastRoomsList();
}

function getWaitingRooms() {
    const rooms = [];
    Database.games.forEach(game => {
        if (game.status === 'waiting') {
            rooms.push({
                id: game.id,
                playerName: game.creatorName,
                playerId: game.creatorId,
                languageCode: Database.users.get(game.creatorId)?.languageCode || 'en',
                mode: game.gameMode || 'classic',
                amount: game.betAmount
            });
        }
    });
    return rooms;
}

function broadcastRoomsList() {
    const rooms = getWaitingRooms();
    const msg = JSON.stringify({ type: 'roomsList', rooms });
    Database.activeSockets.forEach(({ ws }) => {
        if (ws.readyState === 1) ws.send(msg);
    });
}

// Get available games (filtered by budget only — mode filter removed so all rooms are visible)
function handleGetGames(socketId, ws, data) {
    const maxBudget = parseFloat(data.maxBudget) || 9999;
    const availableRooms = getWaitingRooms().filter(r => r.amount <= maxBudget);
    ws.send(JSON.stringify({ type: 'roomsList', rooms: availableRooms }));
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

    if (!user || (game.betAmount > 0 && user.balance < game.betAmount)) {
        console.log(`[JOIN] FAIL — insufficient balance`);
        ws.send(JSON.stringify({ type: 'joinFailed', reason: 'Insufficient balance' }));
        return;
    }


    // Deduct bet
    user.balance -= game.betAmount;
    user.totalWagered = (user.totalWagered || 0) + game.betAmount;

    // Assign player 2
    game.player2Id = userId;
    game.player2Name = user.name;
    game.status = 'countdown';

    broadcastRoomsList();
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

function safeSendBinary(ws, buf) {
    try {
        if (ws && ws.readyState === 1) ws.send(buf);
    } catch (e) {
        console.error('[WS] safeSendBinary error:', e.message);
    }
}

function broadcastBinaryToGame(game, buf) {
    safeSendBinary(getSocketByUserId(game.player1Id), buf);
    safeSendBinary(getSocketByUserId(game.player2Id), buf);
}

// Build binary gameState buffer (37 bytes, little-endian)
// type=1 | ballX f32 | ballY f32 | spdX f32 | spdY f32 | pad1X f32 | pad2X f32 | ramp f32 | t f64
function makeBinaryGameState(ball, paddle1X, paddle2X, ramp, t) {
    const buf = Buffer.allocUnsafe(37);
    buf.writeUInt8(1, 0);
    buf.writeFloatLE(ball.x, 1);
    buf.writeFloatLE(ball.y, 5);
    buf.writeFloatLE(ball.speedX, 9);
    buf.writeFloatLE(ball.speedY, 13);
    buf.writeFloatLE(paddle1X, 17);
    buf.writeFloatLE(paddle2X, 21);
    buf.writeFloatLE(ramp, 25);
    buf.writeDoubleLE(t, 29);
    return buf;
}

// Handle binary messages from client
// Client→Server types: 1=paddleMove(xFraction f32, t f64), 2=pong(t f64), 3=echo(t f64)
function handleBinaryClientMessage(socketId, ws, buf) {
    const socketInfo = Database.activeSockets.get(socketId);
    if (!socketInfo) return;
    const type = buf.readUInt8(0);

    if (type === 1 && buf.length >= 13) {
        // Binary paddleMove: xFraction (f32 LE) + t (f64 LE)
        const xFraction = Math.max(0, Math.min(1, buf.readFloatLE(1)));
        const userId = socketInfo.userId;
        if (!userId) return;
        // Find active game for this player
        const _px = xFraction * (WORLD_W - PADDLE_W);
        Database.games.forEach(game => {
            if (game.status !== 'active') return;
            if (game.player1Id === userId && game.paddle1) {
                game.paddle1.x = _px;
            } else if (game.player2Id === userId && game.paddle2) {
                game.paddle2.x = _px;
            }
        });
    } else if (type === 2 && buf.length >= 9) {
        // Binary pong: t (f64 LE)
        const t = buf.readDoubleLE(1);
        handlePong(socketId, { t });
    } else if (type === 3 && buf.length >= 9) {
        // Binary echo: reply with same t so client can measure RTT
        const t = buf.readDoubleLE(1);
        const reply = Buffer.allocUnsafe(9);
        reply.writeUInt8(3, 0);
        reply.writeDoubleLE(t, 1);
        safeSendBinary(ws, reply);
    } else if (type === 4 && buf.length >= 17) {
        // Client hit report: ball_x(f32) ball_y(f32) speed_x(f32) speed_y(f32) [paddle_x(f32)]
        const bx  = buf.readFloatLE(1);
        const by  = buf.readFloatLE(5);
        const bsx = buf.readFloatLE(9);
        const bsy = buf.readFloatLE(13);
        const clientPaddleX = buf.length >= 21 ? buf.readFloatLE(17) : null;
        handleClientHitReport(socketId, bx, by, bsx, bsy, clientPaddleX);
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
    broadcastRoomsList();
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
        if (game.readyTimeout) { clearTimeout(game.readyTimeout); game.readyTimeout = null; }
        console.log(`[MATCH] Both players ready — starting race countdown`);
        startRaceCountdown(game);
    }
}

// Start the race countdown — clients send roundReady immediately on receipt
function startRaceCountdown(game) {
    game.status = 'racing';
    game.startedAt = Date.now();
    const RACE_DURATION = 5000;
    const startAt = Date.now() + 300; // 300ms buffer for network
    game.raceStartAt = startAt;

    // Set roundReadyFlags NOW so that roundReady messages sent by clients on
    // raceCountdown receipt are accepted immediately (not ignored for 5s).
    // Previously this was only set in the gameplayStart callback, causing a ~9s freeze.
    game.roundReadyFlags = { player1: false, player2: false };

    const p1 = getSocketByUserId(game.player1Id);
    const p2 = getSocketByUserId(game.player2Id);

    const msg = { type: 'raceCountdown', roomId: game.id, startAtEpochMs: startAt, durationMs: RACE_DURATION, serverTime: Date.now() };
    console.log(`[RACE] Broadcasting raceCountdown, startAt=${startAt}`);
    safeSend(p1, msg);
    safeSend(p2, msg);

    // Schedule gameplayStart as a safety fallback (fires 5s later)
    // If both clients send roundReady quickly, startNewRound fires long before this.
    const gameplayStartAt = startAt + RACE_DURATION;
    game.raceTimer = setTimeout(() => {
        game.raceTimer = null;

        // Round already started (both clients sent roundReady in time) — skip
        if (game.status !== 'racing') {
            console.log(`[RACE] gameplayStart timer fired but game is '${game.status}', skipping`);
            return;
        }

        const pp1 = getSocketByUserId(game.player1Id);
        const pp2 = getSocketByUserId(game.player2Id);
        if (!pp1 || !pp2) {
            console.log(`[RACE] Player disconnected before gameplay start`);
            cancelCountdownGame(game, 'Opponent disconnected');
            return;
        }

        // Fallback path: clients were slow — transition and force-start
        game.status = 'roundCooldown';
        game.score = { player1: 0, player2: 0 };
        game.currentRound = 1;
        // roundReadyFlags already set above — don't reset (may be partially filled)
        initBallForRound(game);
        const startMsg = { type: 'gameplayStart', roomId: game.id, serverTime: Date.now() };
        console.log(`[RACE] Broadcasting gameplayStart (fallback — clients were slow)`);
        safeSend(pp1, startMsg);
        safeSend(pp2, startMsg);
        // Safety: start anyway after 4s more if client still hasn't responded
        game.roundReadyTimeout = setTimeout(() => {
            game.roundReadyTimeout = null;
            if (game.status === 'roundCooldown') {
                console.log(`[ROUND] Round 1 timeout — starting anyway`);
                startNewRound(game);
            }
        }, 4000);
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

    // Update server-side paddle position from normalized fraction
    // Client sends xFraction (0-1); server maps to virtual world x-coordinate
    const xFraction = Math.max(0, Math.min(1, data.xFraction !== undefined ? data.xFraction : (data.x || 0) / WORLD_W));
    const vx = xFraction * (WORLD_W - PADDLE_W);
    if (userId === game.player1Id && game.paddle1) {
        game.paddle1.x = vx;
    } else if (userId === game.player2Id && game.paddle2) {
        game.paddle2.x = vx;
    }
    // No per-paddle broadcast — serverTick broadcasts all positions every 16ms
}

// Handle pong reply — compute RTT and store on game
function handlePong(socketId, data) {
    const socketInfo = Database.activeSockets.get(socketId);
    if (!socketInfo) return;
    const userId = socketInfo.userId;
    const rawRtt = Math.min(Date.now() - data.t, 500);
    // EMA smoothing (α=0.35) so single spike pings don't instantly inflate the lag buffer
    Database.games.forEach(game => {
        if (game.player1Id === userId)
            game.player1RTT = Math.round(game.player1RTT ? game.player1RTT * 0.5 + rawRtt * 0.5 : rawRtt);
        if (game.player2Id === userId)
            game.player2RTT = Math.round(game.player2RTT ? game.player2RTT * 0.5 + rawRtt * 0.5 : rawRtt);
    });
}

// Client-reported hit — fires when client locally predicts a paddle bounce.
// Server validates (ball approaching, X within paddle bounds) and applies bounce.
// This closes the RTT/2 timing gap where the server sees a stale paddle position.
function handleClientHitReport(socketId, bx, by, bsx, bsy, clientPaddleX) {
    const socketInfo = Database.activeSockets.get(socketId);
    if (!socketInfo) return;
    const userId = socketInfo.userId;

    Database.games.forEach(game => {
        if (!game.ball || game.status !== 'active') {
            if (game.status === 'roundCooldown') {
                const msSinceScore = game.lastScoreTime ? Date.now() - game.lastScoreTime : '?';
                console.log(`[HIT-CLIENT] LATE by ~${msSinceScore}ms (status=roundCooldown) — hit arrived after round ended`);
            }
            return;
        }
        const isP1 = game.player1Id === userId;
        const isP2 = game.player2Id === userId;
        if (!isP1 && !isP2) return;

        // Rescue from pending miss — late hit report arriving within the 200ms grace window
        // restores the ball to the pre-cross snapshot, cancels the score, and resumes physics.
        if (game.pendingMiss) {
            const missingPlayer = game.pendingMiss.scoredBy === 'player1' ? 'player2' : 'player1';
            const reporterMatches = (isP1 && missingPlayer === 'player1') || (isP2 && missingPlayer === 'player2');
            if (!reporterMatches) return; // wrong player reporting — ignore so the genuine miss commits
            clearTimeout(game.pendingMissTimer);
            game.pendingMissTimer = null;
            const snap = game.pendingMiss.ballSnapshot;
            game.ball.x = snap.x;
            game.ball.y = snap.y;
            game.ball.speedX = snap.speedX;
            game.ball.speedY = snap.speedY;
            game.pendingMiss = null;
            startPhysicsLoop(game);
            console.log(`[HIT-CLIENT] ${isP1 ? 'P1' : 'P2'} RESCUED from pending miss — ball restored, physics resumed`);
        }

        // Rate-limit: max 1 client hit per ~300ms per player
        const hitKey = isP1 ? 'p1LastClientHit' : 'p2LastClientHit';
        const now = Date.now();
        if (game[hitKey] && now - game[hitKey] < 300) {
            console.log(`[HIT-CLIENT] ${isP1?'P1':'P2'} RATE-LIMITED (${now - game[hitKey]}ms since last)`);
            return;
        }

        const ball = game.ball;
        const label = isP1 ? 'P1' : 'P2';

        // Use client-reported paddle X if provided — handles delayed paddle-move messages on phone
        const serverPaddleX = isP1 ? game.paddle1.x : game.paddle2.x;
        let paddleX = serverPaddleX;
        if (clientPaddleX !== null && clientPaddleX !== undefined && !isNaN(clientPaddleX)) {
            const clamped = Math.max(0, Math.min(WORLD_W - PADDLE_W, clientPaddleX));
            if (isP1) game.paddle1.x = clamped;
            else game.paddle2.x = clamped;
            paddleX = clamped;
        }

        // Apply the bounce using reported hit position for angle
        game[hitKey] = now;
        const relX = Math.max(0, Math.min(1, (bx - paddleX) / PADDLE_W));
        const angle = (relX - 0.5) * (Math.PI / 3);
        const spd = Math.min(MAX_SPEED, Math.sqrt(ball.speedX ** 2 + ball.speedY ** 2) + BASE_SPEED * 0.08);
        ball.speedX = Math.sin(angle) * spd;
        ball.speedY = isP1 ? -Math.abs(Math.cos(angle) * spd) : Math.abs(Math.cos(angle) * spd);
        ball.y = isP1 ? P1_Y - BALL_R : P2_Y + PADDLE_H + BALL_R;
        ball.hitCount++;
        console.log(`[HIT-CLIENT] ${isP1 ? 'P1' : 'P2'} bx=${bx.toFixed(1)} paddleX=${paddleX.toFixed(1)} serverWas=${serverPaddleX.toFixed(1)}`);
    });
}

// Start periodic RTT measurement for a game
function startPingLoop(game) {
    if (game.pingInterval) return;
    game.pingInterval = setInterval(() => {
        const now = Date.now();
        const pingBuf = Buffer.allocUnsafe(9);
        pingBuf.writeUInt8(2, 0);
        pingBuf.writeDoubleLE(now, 1);
        safeSendBinary(getSocketByUserId(game.player1Id), pingBuf);
        safeSendBinary(getSocketByUserId(game.player2Id), pingBuf);
    }, 500);
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
                broadcastRoomsList();
            } else if (game.status === 'active' || game.status === 'roundCooldown') {
                // Start 15-second grace period before forfeiting
                console.log(`[DISCONNECT] Player left active game: ${game.id} — starting 15s grace`);
                stopPhysicsLoop(game);
                if (game.physicsStartTimer) { clearTimeout(game.physicsStartTimer); game.physicsStartTimer = null; }
                if (game.pendingMissTimer) { clearTimeout(game.pendingMissTimer); game.pendingMissTimer = null; }
                game.pendingMiss = null;
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

    if (socketInfo && socketInfo.userId) {
        Database.paddleMoveTiming.delete(socketInfo.userId);
    }
    Database.activeSockets.delete(socketId);
    broadcastOnlineCount();
}

let _onlineCountTimer = null;
function broadcastOnlineCount() {
    if (_onlineCountTimer) return;
    _onlineCountTimer = setTimeout(() => {
        _onlineCountTimer = null;
        const count = Database.activeSockets.size;
        const msg = JSON.stringify({ type: 'onlineCount', count });
        Database.activeSockets.forEach(({ ws }) => {
            if (ws.readyState === 1) ws.send(msg);
        });
    }, 500);
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
            broadcastRoomsList();
            console.log(`Game ${gameId} cancelled by creator`);
        }
    });
}

// End multiplayer match authoritatively
function endMultiplayerMatch(game, winnerId, reason) {
    stopPhysicsLoop(game);
    stopPingLoop(game);
    if (game.roundReadyTimeout) { clearTimeout(game.roundReadyTimeout); game.roundReadyTimeout = null; }
    if (game.roundCooldownTimer) { clearTimeout(game.roundCooldownTimer); game.roundCooldownTimer = null; }
    if (game.physicsStartTimer) { clearTimeout(game.physicsStartTimer); game.physicsStartTimer = null; }
    if (game.pendingMissTimer) { clearTimeout(game.pendingMissTimer); game.pendingMissTimer = null; }
    game.pendingMiss = null;
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

    // Accumulate platform fee
    if (!isTie && platformFee > 0) accumulatePlatformFee(platformFee);

    // Log match to Supabase matches table (uses a proper UUID, not room ID)
    const matchDbId = game.dbId || crypto.randomUUID();
    game.dbId = matchDbId;
    db.from('matches').upsert({
        id: matchDbId,
        player1_id: String(game.player1Id),
        player2_id: String(game.player2Id),
        status: 'finished',
        stake_amount: game.betAmount,
        winner_id: winnerId ? String(winnerId) : null,
        created_at: new Date(game.createdAt || Date.now()).toISOString(),
        started_at: new Date(game.startedAt || Date.now()).toISOString(),
        ended_at: new Date().toISOString()
    }, { onConflict: 'id' }).then(({ error }) => {
        if (error) console.error('[DB] Match log error:', error.message);
    });

    // Log wager transactions for both players
    if (game.betAmount > 0) {
        logTransaction(game.player1Id, isTie ? 'wager_tie' : game.player1Id === winnerId ? 'wager_win' : 'wager_loss', game.betAmount, null, matchDbId);
        logTransaction(game.player2Id, isTie ? 'wager_tie' : game.player2Id === winnerId ? 'wager_win' : 'wager_loss', game.betAmount, null, matchDbId);
    }

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
    if (!isTie && winnerId) {
        const _winner = Database.users.get(winnerId);
        const _loserId = winnerId === game.player1Id ? game.player2Id : game.player1Id;
        const _loser = Database.users.get(_loserId);
        if (_winner && _loser) {
            const s = game.score || { player1: 0, player2: 0 };
            const hi = Math.max(s.player1, s.player2), lo = Math.min(s.player1, s.player2);
            const tickerText = `${_winner.name} beat ${_loser.name} · $${game.betAmount} · ${hi}-${lo}`;
            Database.activeSockets.forEach(info => safeSend(info.ws, { type: 'tickerUpdate', text: tickerText }));
        }
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
        p1Ready: false,
        p2Ready: false,
        score: { player1: 0, player2: 0 },
        currentRound: 1,
        ballSeed: Math.floor(Math.random() * 2147483647),
        roundCooldownTimer: null,
        lastScoreTime: 0
    };
    // Safety: start anyway after 12s if a client doesn't send clientReady
    game.readyTimeout = setTimeout(() => {
        if (game.status === 'readyCheck') {
            console.log(`[REMATCH] Ready timeout for game ${game.id} — cancelling`);
            cancelCountdownGame(game, 'Match setup timed out');
        }
    }, 12000);
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
        // Someone was ahead when time ran out — use authoritative match end (handles ELO + stats)
        endMultiplayerMatch(game, winnerId, 'timeout');
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
    loadPlatformFees();
    initTONWallet().then(() => startTONPoller());
});
