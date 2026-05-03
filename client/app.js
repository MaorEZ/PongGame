// Global App State
const AppState = {
    user: {
        id: null,
        name: '',
        balance: 100,
        elo: 100,
        matchesPlayed: 0
    },
    currentGame: null,
    socket: null,
    telegram: null,

    // Player Statistics
    stats: {
        wins: 0,
        losses: 0,
        longestStreak: 0,
        currentStreak: 0,
        totalEarnings: 0,
        bestCombo: 0,
        totalWagered: 0 // Track for unlocks
    },

    // Paddle Customization
    customization: {
        selectedSkin: 'default',
        unlockedSkins: ['default'] // Start with default unlocked
    },

    // Naming system
    naming: {
        displayName: '',
        changesRemaining: 3,
        isSet: false
    }
};

// Initialize Telegram Web App
function initTelegram() {
    try {
        if (window.Telegram && window.Telegram.WebApp) {
            const tg = window.Telegram.WebApp;
            AppState.telegram = tg;

            // Expand to full height
            tg.expand();

            // Theme colors handled by brand.css

            // Get user data from Telegram
            if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
                AppState.user.id = tg.initDataUnsafe.user.id;
                AppState.user.name = tg.initDataUnsafe.user.first_name || 'Player';
                document.getElementById('userName').textContent = AppState.user.name;
            } else {
                // Testing outside Telegram
                AppState.user.id = Math.floor(Math.random() * 1000000);
                AppState.user.name = 'Player ' + AppState.user.id;
                document.getElementById('userName').textContent = AppState.user.name;
            }

            // Check for referral code in start_param
            const startParam = tg.initDataUnsafe && tg.initDataUnsafe.start_param;
            if (startParam && startParam.startsWith('ref_')) {
                window._pendingReferralCode = startParam;
            }

            // Tell Telegram the app is ready
            tg.ready();
        } else {
            // No Telegram SDK - fallback for local testing
            console.warn('Telegram WebApp not available - running in local mode');
            AppState.user.id = Math.floor(Math.random() * 1000000);
            AppState.user.name = 'Player ' + AppState.user.id;
            document.getElementById('userName').textContent = AppState.user.name;
        }
    } catch (e) {
        console.error('initTelegram failed:', e);
        // Ensure user still gets set up
        if (!AppState.user.id) {
            AppState.user.id = Math.floor(Math.random() * 1000000);
            AppState.user.name = 'Player ' + AppState.user.id;
            document.getElementById('userName').textContent = AppState.user.name;
        }
    }

    console.log('Telegram Web App initialized', AppState.user);
}

// Connect to WebSocket Server
function connectToServer() {
    // Use wss:// on HTTPS (production behind Nginx), ws:// on plain HTTP (local dev)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const serverUrl = window.location.protocol === 'https:'
        ? `${protocol}//${window.location.host}`          // production: no port, proxied by Nginx
        : `${protocol}//${window.location.hostname}:3000`; // local dev: explicit port

    try {
        AppState.socket = new WebSocket(serverUrl);

        AppState.socket.onopen = () => {
            console.log('Connected to game server');
            window._hadSuccessfulConnection = true;
            const overlay = document.getElementById('reconnectOverlay');
            if (overlay) overlay.style.display = 'none';

            // Register user with server — include initData so server can verify identity
            AppState.socket.send(JSON.stringify({
                type: 'register',
                userId: AppState.user.id,
                userName: AppState.user.name,
                initData: window.Telegram?.WebApp?.initData || ''
            }));

            // Request user balance
            requestBalance();

            // Apply pending referral code if new user came via invite link
            if (window._pendingReferralCode) {
                sendToServer({ type: 'applyReferral', userId: AppState.user.id, code: window._pendingReferralCode });
                window._pendingReferralCode = null;
            }
        };

        AppState.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('[WS<-]', data.type, data);
                handleServerMessage(data);
            } catch (e) {
                console.error('Failed to parse server message:', e);
            }
        };

        AppState.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        AppState.socket.onclose = () => {
            console.log('Disconnected — retrying in 2s');
            // Only show reconnect overlay after initial load AND a prior successful connection
            if (window._appLoaded && window._hadSuccessfulConnection) {
                const overlay = document.getElementById('reconnectOverlay');
                if (overlay) overlay.style.display = 'flex';
            }
            setTimeout(() => connectToServer(), 2000);
        };

    } catch (error) {
        console.error('Failed to connect to server:', error);
        showNotification('Failed to connect to server');
    }
}

// Handle messages from server
function handleServerMessage(data) {
    console.log('Server message:', data);

    switch (data.type) {
        case 'connected':
            // Server welcome — safe point to verify DB init ran
            console.log('[DB] WS connected. ME_DB=', window.ME_DB, 'supabase=', typeof window.supabase);
            if (!window.ME_DB && typeof initPlayerDB === 'function') {
                console.log('[DB] ME_DB not set yet — retrying initPlayerDB after connect');
                initPlayerDB();
            }
            break;

        case 'ping':
            sendToServer({ type: 'pong', t: data.t });
            break;

        case 'profileData':
            showProfileScreen(data);
            break;

        case 'matchEmoji':
            showReceivedEmoji(data.emoji);
            break;

        case 'totalWagered':
            AppState.user.totalWagered = data.amount;
            break;

        case 'chatHistory':
            renderChatHistory(data.messages || []);
            break;

        case 'chatMessage':
            appendChatMessage(data);
            break;

        case 'giftReceived':
            showNotification(`Received $${(data.amount || 0).toFixed(2)} from ${data.fromName || data.from}!`);
            hapticFeedback('success');
            requestBalance();
            break;

        case 'giftSent':
            showNotification(`Gift sent! -$${(data.amountDeducted || 0).toFixed(2)}`);
            requestBalance();
            break;

        case 'doubleOrNothingOffer': {
            window._pendingDoubleOfferId = data.offerId;
            const dBanner = document.getElementById('doubleOfferBanner');
            const dText   = document.getElementById('doubleOfferText');
            if (dBanner) {
                if (dText) dText.textContent = `${data.fromName} challenges you — Double or Nothing! ($${(data.betAmount || 0).toFixed(2)} → $${((data.betAmount || 0) * 2).toFixed(2)})`;
                dBanner.style.display = 'block';
            }
            hapticFeedback('medium');
            showNotification(`${data.fromName} wants Double or Nothing!`);
            break;
        }

        case 'doubleOrNothingDeclined':
            showNotification('Opponent declined the Double or Nothing.');
            break;

        case 'doubleOrNothingExpired': {
            const b = document.getElementById('doubleOfferBanner');
            if (b) b.style.display = 'none';
            window._pendingDoubleOfferId = null;
            showNotification('Double or Nothing offer expired.');
            break;
        }

        case 'balance':
            updateBalance(data.balance);
            break;

        case 'gamesList':
            updateGamesList(data.games);
            break;

        case 'roomsList':
            // Update room browser with server rooms + own active room
            if (typeof updateRoomBrowser === 'function') {
                const rooms = data.rooms || [];
                // Include own active room if it matches current filters
                if (typeof activeRoom !== 'undefined' && activeRoom) {
                    const alreadyIncluded = rooms.some(r => r.id === activeRoom.id);
                    if (!alreadyIncluded) {
                        rooms.push({
                            id: activeRoom.id,
                            playerName: AppState.user.name,
                            mode: activeRoom.mode,
                            amount: activeRoom.amount,
                            playerId: AppState.user.id,
                            isSelf: true
                        });
                    }
                }
                updateRoomBrowser(rooms);
            }
            break;

        case 'gameCreated':
            showNotification('Room created! Waiting for opponent...');
            break;

        case 'gameJoined':
            // Someone joined - auto-pull into game regardless of current screen
            AppState.currentGame = data.game;
            if (typeof activeRoom !== 'undefined') activeRoom = null;
            if (typeof waitingRoomTimer !== 'undefined' && waitingRoomTimer) {
                clearInterval(waitingRoomTimer);
                waitingRoomTimer = null;
            }
            showScreen('gameScreen');
            initGame(data.game);
            break;

        case 'gameStart':
            // Auto-pull into game no matter where in the app
            if (typeof waitingRoomTimer !== 'undefined' && waitingRoomTimer) {
                clearInterval(waitingRoomTimer);
                waitingRoomTimer = null;
            }
            showScreen('gameScreen');
            startGame(data.game);
            break;

        case 'gameUpdate':
            updateGame(data);
            break;

        case 'gameEnd':
            endGame(data);
            if (typeof activeRoom !== 'undefined') activeRoom = null;
            break;

        case 'joinAccepted':
            // Clear join timeout
            if (window._joinTimeout) { clearTimeout(window._joinTimeout); window._joinTimeout = null; }
            // Clear active room (host's room is consumed)
            if (typeof activeRoom !== 'undefined') activeRoom = null;
            // Navigate to countdown screen and populate it
            showScreen('matchCountdownScreen');
            if (typeof populateCountdownScreen === 'function') {
                populateCountdownScreen(data);
            }
            break;

        case 'joinFailed':
            // Clear join timeout
            if (window._joinTimeout) { clearTimeout(window._joinTimeout); window._joinTimeout = null; }
            showNotification(data.reason || 'Failed to join room');
            hapticFeedback('error');
            // Re-enable join buttons
            document.querySelectorAll('.rb-join').forEach(btn => {
                btn.disabled = false;
                btn.textContent = 'Join';
            });
            // Refund was already deducted client-side — server didn't deduct so we get balance update
            requestBalance();
            break;

        case 'matchCountdown':
            if (typeof updateCountdownRing === 'function') {
                updateCountdownRing(data.secondsLeft);
            }
            break;

        case 'matchReady':
            // Server says both players matched — load game screen and report ready
            try {
                console.log('[MATCH] matchReady received, loading game screen');
                if (data.newBalance !== undefined) updateBalance(data.newBalance);
                AppState.currentGame = data.game;
                window._currentRoomId = data.game.id;
                window.MATCH_ID  = null; // reset for this new match
                window.OPP_DB_ID = null;
                showScreen('gameScreen');
                if (typeof initGame === 'function') {
                    initGame(data.game);
                }
                // Create DB match row (non-blocking)
                createDBMatch();
                // Initialize SFX early (needs user gesture context — we had tap on Join)
                if (typeof SFX !== 'undefined') SFX.init();
                // Tell server we're ready
                console.log('[MATCH] Sending clientReady');
                sendToServer({ type: 'clientReady', userId: AppState.user.id, roomId: data.game.id });
                // Start resync timeout — if no raceCountdown within 8s, ask server
                window._resyncTimeout = setTimeout(() => {
                    console.log('[RESYNC] No raceCountdown received, requesting resync');
                    sendToServer({ type: 'resync', userId: AppState.user.id, roomId: data.game.id });
                }, 8000);
            } catch (e) {
                console.error('[MATCH] matchReady handler error:', e);
            }
            break;

        case 'matchStart':
            // Legacy fallback — treat as matchReady
            console.log('[MATCH] Legacy matchStart, treating as matchReady');
            AppState.currentGame = data.game;
            showScreen('gameScreen');
            if (typeof initGame === 'function') initGame(data.game);
            break;

        case 'raceCountdown':
            // 5-second NFS-style countdown before gameplay
            try {
                console.log('[RACE] raceCountdown received, startAt=' + data.startAtEpochMs + ' serverTime=' + data.serverTime);
                if (window._resyncTimeout) { clearTimeout(window._resyncTimeout); window._resyncTimeout = null; }
                if (typeof showRaceCountdown === 'function') {
                    showRaceCountdown(data.startAtEpochMs, data.durationMs, data.serverTime);
                }
            } catch (e) {
                console.error('[RACE] raceCountdown handler error:', e);
            }
            break;

        case 'gameplayStart':
            // Server confirms gameplay — start immediately
            try {
                console.log('[GAME] gameplayStart received');
                if (window._resyncTimeout) { clearTimeout(window._resyncTimeout); window._resyncTimeout = null; }
                if (typeof startGameplay === 'function') {
                    startGameplay();
                }
            } catch (e) {
                console.error('[GAME] gameplayStart handler error:', e);
            }
            break;

        case 'roundCooldown':
            // Server-authoritative round result — freeze game and update scores
            try {
                if (typeof onRoundCooldown === 'function') onRoundCooldown(data);
            } catch (e) { console.error('[ROUND] roundCooldown error:', e); }
            break;

        case 'roundResume':
            // Server signals next round — start countdown
            try {
                if (typeof onRoundResume === 'function') onRoundResume(data);
            } catch (e) { console.error('[ROUND] roundResume error:', e); }
            break;

        case 'gameState':
            // Server-authoritative ball + paddle positions at ~60fps
            if (typeof window.applyServerGameState === 'function') window.applyServerGameState(data);
            break;

        case 'roundStart':
            // Both clients ready — server activates the round
            if (data.fairCommitment) AppState.fairCommitment = data.fairCommitment;
            try {
                if (typeof window.onRoundStart === 'function') window.onRoundStart(data);
            } catch (e) { console.error('[ROUND] roundStart error:', e); }
            break;

        case 'gameOver':
            if (data.newElo !== undefined) AppState.user.elo = data.newElo;
            if (data.matchesPlayed !== undefined) AppState.user.matchesPlayed = data.matchesPlayed;
            if (data.fairReveal) verifyProvablyFair(data.fairReveal);
            try {
                if (typeof activeRoom !== 'undefined') activeRoom = null;
                if (typeof onGameOver === 'function') onGameOver(data);
            } catch (e) { console.error('[GAME] gameOver error:', e); }
            break;

        case 'rematchOffer':
            // Opponent wants a rematch
            try {
                if (typeof showRematchOfferBanner === 'function') showRematchOfferBanner(data);
            } catch (e) { console.error('[REMATCH] rematchOffer error:', e); }
            break;

        case 'rematchSent':
            showNotification('Rematch offer sent! Waiting for opponent...');
            break;

        case 'rematchDeclined':
            showNotification(data.reason || 'Opponent declined the rematch.');
            hapticFeedback('error');
            break;

        case 'rematchExpired':
            showNotification('Rematch offer expired.');
            break;

        case 'rematchOfferExpired':
            // Hide the offer banner if still visible
            try {
                if (typeof hideRematchOfferBanner === 'function') hideRematchOfferBanner();
            } catch (e) {}
            break;

        case 'matchCancelled':
            console.log('[MATCH] matchCancelled:', data.reason);
            if (window._resyncTimeout) { clearTimeout(window._resyncTimeout); window._resyncTimeout = null; }
            if (typeof window.clearGraceCountdown === 'function') window.clearGraceCountdown();
            showNotification(data.reason || 'Match cancelled');
            hapticFeedback('error');
            showScreen('roomBrowserScreen');
            break;

        case 'onlineCount': {
            const el = document.getElementById('onlineCountText');
            if (el) el.textContent = data.count === 1 ? '1 player online' : `${data.count} players online`;
            break;
        }

        case 'tickerUpdate':
            addToTicker('🏆 ' + data.text);
            break;

        case 'referralCode':
            window._myReferralCode = data.code;
            break;

        case 'referralApplied':
            showNotification('Referral applied! Your friend gets a bonus on their first match win.');
            break;

        case 'referralBonus':
            showNotification(`+$${data.amount.toFixed(2)} referral bonus from ${data.fromPlayer}'s first match!`);
            hapticFeedback('success');
            requestBalance();
            break;

        case 'leaderboard':
            window._leaderboardData = data;
            if (typeof renderLeaderboard === 'function') renderLeaderboard(data);
            break;

        case 'playerStats':
            AppState.user.elo = data.elo || 100;
            AppState.user.matchesPlayed = data.matchesPlayed || 0;
            break;

        case 'matchHistory':
            if (typeof renderMatchHistory === 'function') renderMatchHistory(data.history || []);
            break;

        case 'opponentDisconnected':
            showNotification(`Opponent disconnected — waiting ${data.graceSecs}s for reconnect...`);
            if (typeof window.startGraceCountdown === 'function') window.startGraceCountdown(data.graceSecs);
            break;

        case 'opponentReconnected':
            showNotification('Opponent reconnected!');
            hapticFeedback('success');
            if (typeof window.clearGraceCountdown === 'function') window.clearGraceCountdown();
            break;

        case 'resyncAfterReconnect':
            showNotification('Reconnected to your game!');
            hapticFeedback('success');
            showScreen('gameScreen');
            if (typeof window.applyServerGameState === 'function') window.applyServerGameState(data);
            break;

        case 'error':
            showNotification(data.message);
            break;

        default:
            console.log('Unknown message type:', data.type);
    }
}

// Open a player's profile by name (called from leaderboard/room browser/result screen, chat)
window.openProfile = function(username) {
    sendToServer({ type: 'getProfile', username });
    showScreen('profileScreen');
    document.getElementById('profileName').textContent = username;
    document.getElementById('profileAvatar').textContent = username ? username[0].toUpperCase() : '?';
    document.getElementById('profileMatches').innerHTML = '<p style="color:#666;font-size:13px;">Loading...</p>';
    const giftBtn = document.getElementById('profileGiftBtn');
    if (giftBtn) giftBtn.style.display = 'none';
};

function showProfileScreen(data) {
    if (data.error) {
        document.getElementById('profileMatches').innerHTML = `<p style="color:#ef4444;">${data.error}</p>`;
        return;
    }
    document.getElementById('profileName').textContent = data.name;
    document.getElementById('profileAvatar').textContent = data.name ? data.name[0].toUpperCase() : '?';
    document.getElementById('profileElo').textContent = `${data.elo} ELO`;
    document.getElementById('profileWins').textContent = data.wins;
    document.getElementById('profileWinRate').textContent = `${data.winRate}%`;
    document.getElementById('profileEarnings').textContent = `$${(data.earnings || 0).toFixed(2)}`;

    // Show gift button only for other players
    const giftBtn = document.getElementById('profileGiftBtn');
    if (giftBtn) {
        if (data.name && data.name !== AppState.user.name) {
            giftBtn.style.display = 'inline-block';
            giftBtn.onclick = () => { if (typeof openGiftModal === 'function') openGiftModal(data.name); };
        } else {
            giftBtn.style.display = 'none';
        }
    }

    const matchesEl = document.getElementById('profileMatches');
    if (!data.recentMatches || data.recentMatches.length === 0) {
        matchesEl.innerHTML = '<p style="color:#666;font-size:13px;">No matches yet</p>';
        return;
    }
    matchesEl.innerHTML = data.recentMatches.map(m => {
        const color = m.result === 'win' ? '#22c55e' : m.result === 'loss' ? '#ef4444' : '#94a3b8';
        const sign = m.netChange >= 0 ? '+' : '';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
            <span style="color:${color};font-weight:600;text-transform:uppercase;font-size:12px;">${m.result}</span>
            <span style="color:#ccc;font-size:13px;">vs ${m.opponentName || '?'}</span>
            <span style="color:${color};font-size:13px;">${sign}$${Math.abs(m.netChange || 0).toFixed(2)}</span>
        </div>`;
    }).join('');
}

function showReceivedEmoji(emoji) {
    const el = document.getElementById('emojiReceived');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = emoji;
    setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// Live match ticker
window._tickerItems = [];
function addToTicker(text) {
    window._tickerItems.unshift(text);
    if (window._tickerItems.length > 6) window._tickerItems.pop();
    const el = document.getElementById('liveTicker');
    if (!el) return;
    const content = window._tickerItems.join('   ·   ');
    el.textContent = content + '          ' + content;
    el.style.animation = 'none';
    void el.offsetWidth; // force reflow to restart animation
    el.style.animation = 'tickerScroll 40s linear infinite';
}

// Chat rendering helpers
function appendChatMessage(msg) {
    const el = document.getElementById('chatMessages');
    if (!el) return;
    const isMe = String(msg.userId) === String(AppState.user.id);
    const div = document.createElement('div');
    div.style.cssText = `max-width:85%; align-self:${isMe ? 'flex-end' : 'flex-start'};`;
    const safeName = (typeof escapeHtml === 'function') ? escapeHtml(msg.userName) : msg.userName;
    const safeText = (typeof escapeHtml === 'function') ? escapeHtml(msg.text) : msg.text;
    const nameHtml = isMe
        ? '<span style="color:#94a3b8;">You</span>'
        : `<span style="cursor:pointer;color:#4fd1c5;text-decoration:underline;" onclick="openProfile('${safeName}')">${safeName}</span>`;
    div.innerHTML = `
        <div style="font-size:10px; color:#888; margin-bottom:2px; text-align:${isMe ? 'right' : 'left'};">${nameHtml}</div>
        <div style="background:${isMe ? 'rgba(79,209,197,0.18)' : 'rgba(255,255,255,0.08)'}; border-radius:10px; padding:8px 12px; font-size:13px; color:#e2e8f0; word-break:break-word;">${safeText}</div>
    `;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    // Unread badge when panel is closed and message is from someone else
    if (!isMe && typeof window._chatPanelIsOpen === 'function' && !window._chatPanelIsOpen()) {
        if (typeof window._chatShowUnread === 'function') window._chatShowUnread();
    }
}

function renderChatHistory(messages) {
    const el = document.getElementById('chatMessages');
    if (!el) return;
    el.innerHTML = '';
    if (!messages || messages.length === 0) {
        el.innerHTML = '<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">No messages yet — say something!</div>';
        return;
    }
    messages.forEach(msg => appendChatMessage(msg));
}

// Provably fair: verify server commitment after match
async function verifyProvablyFair({ ballSeed, serverSecret, commitment }) {
    try {
        const msg = ballSeed.toString() + serverSecret;
        const encoded = new TextEncoder().encode(msg);
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
        const computed = Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        const verified = computed === commitment;
        AppState.lastFairness = { ballSeed, serverSecret, commitment, computed, verified };
        showFairnessResult(verified, ballSeed, serverSecret, commitment);
    } catch (e) {
        console.error('Fairness verification failed:', e);
    }
}

function showFairnessResult(verified, ballSeed, serverSecret, commitment) {
    const el = document.getElementById('fairnessResult');
    const icon = document.getElementById('fairnessIcon');
    const details = document.getElementById('fairnessDetails');
    if (!el) return;
    el.style.display = 'block';
    icon.textContent = verified ? '✓ Provably Fair' : '✗ Verification Failed';
    icon.style.color = verified ? '#10b981' : '#ef4444';
    details.innerHTML =
        `<div class="fair-row"><span>Seed</span><code>${ballSeed}</code></div>` +
        `<div class="fair-row"><span>Secret</span><code>${serverSecret.slice(0,8)}…</code></div>` +
        `<div class="fair-row"><span>Commitment</span><code>${commitment.slice(0,16)}…</code></div>`;
}

// Request user balance from server
function requestBalance() {
    if (AppState.socket && AppState.socket.readyState === WebSocket.OPEN) {
        AppState.socket.send(JSON.stringify({
            type: 'getBalance',
            userId: AppState.user.id
        }));
    }
}

// Update balance display
function updateBalance(balance) {
    AppState.user.balance = parseFloat(balance);
    document.getElementById('balanceAmount').textContent = balance.toFixed(2);

    const availableBalance = document.getElementById('availableBalance');
    if (availableBalance) availableBalance.textContent = balance.toFixed(2);

    const depositBalanceDisplay = document.getElementById('depositBalanceDisplay');
    if (depositBalanceDisplay) depositBalanceDisplay.textContent = balance.toFixed(2);
}

// Screen Navigation
function showScreen(screenId) {
    console.log('[NAV] showScreen called:', screenId);

    // Reset scroll position so every screen starts at the top
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;

    // Hide all screens
    const screens = document.querySelectorAll('.screen');
    screens.forEach(screen => screen.classList.remove('active'));

    // Stop paddle preview animations when leaving customization
    if (screenId !== 'customizationScreen' && typeof stopAllPaddlePreviews === 'function') {
        stopAllPaddlePreviews();
    }

    // Show target screen
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.add('active');
    }

    // Restart menu paddle animation when returning to main menu
    if (screenId === 'mainMenu' && typeof animateMenuPaddleBall === 'function') {
        animateMenuPaddleBall();
    }

    console.log('Showing screen:', screenId);
}

// Show notification — non-blocking DOM toast (never use alert/showAlert which freeze JS)
function showNotification(message, duration = 3000) {
    // Remove existing toast
    const old = document.getElementById('appToast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.id = 'appToast';
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;top:env(safe-area-inset-top,12px);left:50%;transform:translateX(-50%) translateY(-100%);' +
        'background:#1e293b;color:#e2e8f0;padding:10px 20px;border-radius:10px;font-size:0.85rem;font-weight:600;' +
        'z-index:9999;border:1px solid #334155;box-shadow:0 4px 20px rgba(0,0,0,0.5);' +
        'transition:transform 0.25s ease-out;pointer-events:none;text-align:center;max-width:85vw;';
    document.body.appendChild(toast);

    // Slide in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.style.transform = 'translateX(-50%) translateY(12px)';
        });
    });

    // Slide out and remove
    setTimeout(() => {
        toast.style.transform = 'translateX(-50%) translateY(-100%)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Show confirmation dialog
function showConfirm(message, callback) {
    if (AppState.telegram && AppState.telegram.showConfirm) {
        AppState.telegram.showConfirm(message, callback);
    } else {
        const result = confirm(message);
        callback(result);
    }
}

// Haptic feedback (Telegram feature)
function hapticFeedback(type = 'light') {
    if (AppState.telegram && AppState.telegram.HapticFeedback) {
        switch (type) {
            case 'light':
                AppState.telegram.HapticFeedback.impactOccurred('light');
                break;
            case 'medium':
                AppState.telegram.HapticFeedback.impactOccurred('medium');
                break;
            case 'heavy':
                AppState.telegram.HapticFeedback.impactOccurred('heavy');
                break;
            case 'success':
                AppState.telegram.HapticFeedback.notificationOccurred('success');
                break;
            case 'error':
                AppState.telegram.HapticFeedback.notificationOccurred('error');
                break;
        }
    }
}

// Send message to server
function sendToServer(data) {
    if (AppState.socket && AppState.socket.readyState === WebSocket.OPEN) {
        AppState.socket.send(JSON.stringify(data));
    } else {
        console.error('Not connected to server');
        showNotification('Not connected to server');
    }
}

// Player Statistics Functions
function recordWin(earnings, betAmount) {
    AppState.stats.wins++;
    AppState.stats.currentStreak++;
    AppState.stats.totalEarnings += earnings;
    AppState.stats.totalWagered += betAmount;

    if (AppState.stats.currentStreak > AppState.stats.longestStreak) {
        AppState.stats.longestStreak = AppState.stats.currentStreak;
    }

    checkUnlocks();
    saveStats();
}

function recordLoss(betAmount) {
    AppState.stats.losses++;
    AppState.stats.currentStreak = 0;
    AppState.stats.totalWagered += betAmount;

    checkUnlocks();
    saveStats();
}

function checkUnlocks() {
    const wagered = AppState.stats.totalWagered;
    const unlocked = AppState.customization.unlockedSkins;

    // Sakura paddle: $100 wagered
    if (wagered >= 100 && !unlocked.includes('sakura')) {
        unlocked.push('sakura');
        showNotification('Sakura Paddle Unlocked!');
        hapticFeedback('success');
    }

    // Solar paddle: $500 wagered
    if (wagered >= 500 && !unlocked.includes('solar')) {
        unlocked.push('solar');
        showNotification('Solar Paddle Unlocked!');
        hapticFeedback('success');
    }
}

function purchasePaddle(skinName) {
    const prices = {
        frost: 10,
        void: 50
    };

    const price = prices[skinName];
    if (!price) return false;

    // Check if already owned
    if (AppState.customization.unlockedSkins.includes(skinName)) {
        showNotification('You already own this paddle!');
        return false;
    }

    // Check balance
    if (AppState.user.balance < price) {
        showNotification('Insufficient balance!');
        hapticFeedback('error');
        return false;
    }

    // Purchase paddle
    AppState.user.balance -= price;
    updateBalance(AppState.user.balance);
    AppState.customization.unlockedSkins.push(skinName);
    saveStats();

    const name = skinName.charAt(0).toUpperCase() + skinName.slice(1);
    showNotification(`${name} Paddle Purchased!`);
    hapticFeedback('success');

    return true;
}

function getUnlockProgress(skinName) {
    const wagered = AppState.stats.totalWagered;
    const requirements = {
        sakura: 100,
        solar: 500
    };

    const required = requirements[skinName];
    const progress = Math.min(100, (wagered / required) * 100);
    return { progress, wagered, required };
}

function saveStats() {
    // Save to localStorage for persistence
    localStorage.setItem('paddleArenaStats', JSON.stringify(AppState.stats));
    localStorage.setItem('paddleArenaCustomization', JSON.stringify(AppState.customization));
}

function loadStats() {
    // Load from localStorage
    const savedStats = localStorage.getItem('paddleArenaStats');
    const savedCustomization = localStorage.getItem('paddleArenaCustomization');

    if (savedStats) {
        AppState.stats = JSON.parse(savedStats);
    }

    if (savedCustomization) {
        AppState.customization = JSON.parse(savedCustomization);
    }
}

// Naming System
function loadNaming() {
    const saved = localStorage.getItem('paddleArenaNaming');
    if (saved) {
        AppState.naming = JSON.parse(saved);
    }
}

function saveNaming() {
    localStorage.setItem('paddleArenaNaming', JSON.stringify(AppState.naming));
}

function validateName(name) {
    if (!name || name.length < 3 || name.length > 16) return false;
    return /^[a-zA-Z0-9_]+$/.test(name);
}

function setDisplayName(name) {
    if (!validateName(name)) {
        showNotification('Invalid name. 3-16 chars, letters/numbers/underscores only.');
        return false;
    }

    if (AppState.naming.isSet && AppState.naming.changesRemaining <= 0) {
        showNotification('No name changes remaining!');
        return false;
    }

    if (AppState.naming.isSet) {
        AppState.naming.changesRemaining--;
    }

    AppState.naming.displayName = name;
    AppState.naming.isSet = true;
    AppState.user.name = name;
    saveNaming();

    // Update UI
    document.getElementById('userName').textContent = name;
    return true;
}

function initNameSetup() {
    const confirmBtn = document.getElementById('confirmNameBtn');
    const nameInput = document.getElementById('nameInput');

    confirmBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (setDisplayName(name)) {
            showScreen('mainMenu');
            hapticFeedback('success');
        }
    });

    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmBtn.click();
    });
}

function selectPaddleSkin(skinName) {
    // 'default' (Basic) is always available
    if (skinName === 'default' || AppState.customization.unlockedSkins.includes(skinName)) {
        AppState.customization.selectedSkin = skinName;
        if (typeof Game !== 'undefined') Game.paddleSkin = skinName;
        saveStats();
        return true;
    }
    return false;
}

// =============================================
// SUPABASE DB HELPERS
// =============================================
console.log('[DB] DB module loaded');

// B) Upsert current player into users table — called once at boot
async function initPlayerDB() {
    console.log('[DB] initPlayerDB called, supabase=', typeof window.supabase);
    if (!window.supabase) { console.error('[DB] initPlayerDB — window.supabase is undefined! Check CDN script load order.'); return; }
    try {
        const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
        let telegram_id, username;

        if (tgUser && tgUser.id) {
            telegram_id = String(tgUser.id);
            username = tgUser.username || tgUser.first_name || 'Player';
        } else {
            // Local fallback — stable id stored in localStorage
            let localId = localStorage.getItem('local_user_id');
            if (!localId) {
                localId = 'local_' + Math.floor(Math.random() * 1e9);
                localStorage.setItem('local_user_id', localId);
            }
            telegram_id = localId;
            username = AppState.user.name || 'Player';
        }

        const { data, error } = await window.supabase
            .from('users')
            .upsert({ telegram_id, username, last_seen: new Date().toISOString() }, { onConflict: 'telegram_id' })
            .select()
            .single();

        if (error) { console.error('[DB] initPlayerDB error:', error); return; }
        window.ME_DB = data;
        console.log('[DB] ME_DB:', window.ME_DB);
    } catch (e) {
        console.error('[DB] initPlayerDB exception:', e);
    }
}

// C) Create a match row when both players are confirmed and countdown begins
async function createDBMatch() {
    console.log('[DB] createDBMatch called, MATCH_ID=', window.MATCH_ID, 'ME_DB=', window.ME_DB);
    if (window.MATCH_ID) { console.log('[DB] createDBMatch skipped — MATCH_ID already set'); return; }
    if (!window.supabase) { console.error('[DB] createDBMatch — window.supabase undefined'); return; }
    if (!window.ME_DB) {
        console.warn('[DB] createDBMatch — ME_DB not ready, calling initPlayerDB');
        await initPlayerDB();
    }
    if (!window.ME_DB) { console.error('[DB] createDBMatch — ME_DB unavailable, bailing'); return; }

    const game = AppState.currentGame;
    if (!game) { console.error('[DB] createDBMatch — no AppState.currentGame'); return; }

    try {
        // Upsert real opponent so they have a users row
        const isP1 = String(game.player1Id) === String(AppState.user.id);
        const oppTelegramId = String(isP1 ? game.player2Id : game.player1Id);
        const oppName = isP1 ? (game.player2Name || 'Opponent') : (game.player1Name || 'Opponent');

        const { data: opp, error: oppErr } = await window.supabase
            .from('users')
            .upsert({ telegram_id: oppTelegramId, username: oppName, last_seen: new Date().toISOString() }, { onConflict: 'telegram_id' })
            .select()
            .single();
        if (oppErr) { console.error('[DB] createDBMatch — opponent upsert error:', oppErr); return; }

        // Store opponent DB id so finishDBMatch can set correct winner when we lose
        window.OPP_DB_ID = opp.id;

        // Insert match row
        const { data: match, error: matchErr } = await window.supabase
            .from('matches')
            .insert({
                player1_id: window.ME_DB.id,
                player2_id: opp.id,
                status: 'active',
                started_at: new Date().toISOString()
            })
            .select()
            .single();
        if (matchErr) { console.error('[DB] createDBMatch — insert error:', matchErr); return; }

        window.MATCH_ID = match.id;
        console.log('[DB] MATCH_ID created:', window.MATCH_ID);
    } catch (e) {
        console.error('[DB] createDBMatch exception:', e);
    }
}

// D) Update match row to finished when game ends
async function finishDBMatch(iWon) {
    console.log('[DB] finishDBMatch called', { MATCH_ID: window.MATCH_ID, iWon });
    if (!window.MATCH_ID) { console.warn('[DB] finishDBMatch — no MATCH_ID, skipping'); return; }
    if (!window.ME_DB)    { console.warn('[DB] finishDBMatch — no ME_DB, skipping'); return; }
    if (!window.supabase) { console.error('[DB] finishDBMatch — window.supabase undefined'); return; }
    const savedId  = window.MATCH_ID;
    const savedOpp = window.OPP_DB_ID;
    window.MATCH_ID   = null; // clear immediately so double-calls are no-ops
    window.OPP_DB_ID  = null;
    try {
        // Use real winner DB id: mine if I won, opponent's if I lost, null if tie
        const winner_id = iWon ? window.ME_DB.id : (savedOpp || null);
        const { error } = await window.supabase
            .from('matches')
            .update({ status: 'finished', winner_id, ended_at: new Date().toISOString() })
            .eq('id', savedId);

        if (error) { console.error('[DB] finishDBMatch error:', error); }
        else        { console.log('[DB] match finished:', savedId, 'winner=', winner_id); }
    } catch (e) {
        console.error('[DB] finishDBMatch exception:', e);
    }
}

// Export DB functions to window so any script can call them safely
window.initPlayerDB = initPlayerDB;
window.createDBMatch = createDBMatch;
window.finishDBMatch = finishDBMatch;

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    console.log('App loading...');

    try {
        // Load saved stats and naming
        loadStats();
        loadNaming();

        // Apply saved paddle skin
        if (typeof Game !== 'undefined' && AppState.customization.selectedSkin) {
            Game.paddleSkin = AppState.customization.selectedSkin;
        }

        // Initialize Telegram
        initTelegram();

        // Upsert player into Supabase (non-blocking)
        console.log('[DB] calling initPlayerDB at boot');
        if (window.initPlayerDB) {
            window.initPlayerDB();
        } else {
            console.error('[DB] initPlayerDB missing on window');
        }

        // Override with saved display name if set
        if (AppState.naming.isSet && AppState.naming.displayName) {
            AppState.user.name = AppState.naming.displayName;
            document.getElementById('userName').textContent = AppState.naming.displayName;
        }

        // Initialize name setup UI
        initNameSetup();

        // Connect to server
        setTimeout(() => {
            connectToServer();
        }, 500);
    } catch (e) {
        console.error('Init error:', e);
    }

    // Transition off loading screen after animation completes
    let _loadingDone = false;
    function _exitLoading() {
        if (_loadingDone) return;
        _loadingDone = true;

        // Show the target screen before fading out loading screen
        try {
            if (!AppState.naming.isSet) {
                const nameInput = document.getElementById('nameInput');
                if (AppState.user.name && AppState.user.name !== 'Player') {
                    if (nameInput) nameInput.value = AppState.user.name.replace(/[^a-zA-Z0-9_]/g, '');
                }
                const changesEl = document.getElementById('nameChangesLeft');
                if (changesEl) changesEl.textContent = 'Name changes remaining: ' + AppState.naming.changesRemaining;
                showScreen('nameSetupScreen');
            } else {
                showScreen('mainMenu');
            }
        } catch (e) {
            console.error('Screen transition error:', e);
            try { showScreen('mainMenu'); } catch (_) {}
        }

        // Ensure reconnect overlay doesn't block the initial screen
        const overlay = document.getElementById('reconnectOverlay');
        if (overlay) overlay.style.display = 'none';

        // Mark app as loaded now — overlay is gated on _hadSuccessfulConnection anyway
        window._appLoaded = true;

        // Hide loading screen in the same JS tick as showScreen so both paint together
        const ls = document.getElementById('loadingScreen');
        if (ls) ls.style.display = 'none';
    }
    // Single reliable timeout — animation is 2.2s, we fire at 2.4s
    setTimeout(_exitLoading, 2400);
});

// Handle app close
window.addEventListener('beforeunload', () => {
    if (AppState.socket) {
        AppState.socket.close();
    }
});
