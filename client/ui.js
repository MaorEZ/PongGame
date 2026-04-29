// Menu System - Handles all UI interactions and navigation

// Escape user-controlled strings before inserting into innerHTML
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Global state for selected bet amount and game mode
let selectedBetAmount = 0;
let selectedGameMode = 'classic'; // 'classic' or 'chaotic'
let selectedBudget = 0; // Budget filter for room browser
let currentMatchId = null;
let roomPollingInterval = null;
let rematchTimer = null;
let waitingRoomTimer = null;

// Room management - player can only have one active room
let activeRoom = null; // { id, mode, amount }

function updateMenuProfile() {
    const name = AppState.user.name || 'Player';
    const initials = name.substring(0, 2).toUpperCase();
    const balance = AppState.user.balance || 0;
    const wins = AppState.stats.wins || 0;
    const losses = AppState.stats.losses || 0;
    const winRate = wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) : 0;
    const elo = AppState.user.elo || 1000;

    const avatarEl = document.getElementById('menuProfileAvatar');
    const nameEl   = document.getElementById('menuProfileName');
    const balEl    = document.getElementById('menuProfileBalance');
    const winsEl   = document.getElementById('menuStatWins');
    const lossEl   = document.getElementById('menuStatLosses');
    const rateEl   = document.getElementById('menuStatWinRate');
    const eloEl    = document.getElementById('menuStatElo');

    if (avatarEl) avatarEl.textContent = initials;
    if (nameEl)   nameEl.textContent   = name;
    if (balEl)    balEl.textContent    = '$' + balance.toFixed(2) + ' USDT';
    if (winsEl)   winsEl.textContent   = wins;
    if (lossEl)   lossEl.textContent   = losses;
    if (rateEl)   rateEl.textContent   = winRate + '%';
    if (eloEl)    eloEl.textContent    = elo;
}

// Hamburger Menu Toggle
document.getElementById('hamburgerBtn').addEventListener('click', () => {
    const slideMenu = document.getElementById('slideMenu');
    const menuOverlay = document.getElementById('menuOverlay');
    const hamburgerBtn = document.getElementById('hamburgerBtn');

    slideMenu.classList.add('active');
    menuOverlay.classList.add('active');
    hamburgerBtn.classList.add('active');

    updateMenuProfile();
    hapticFeedback('light');
});

// Close Menu
document.getElementById('closeMenuBtn').addEventListener('click', () => {
    closeSlideMenu();
});

// Close menu when clicking overlay
document.getElementById('menuOverlay').addEventListener('click', () => {
    closeSlideMenu();
});

function closeSlideMenu() {
    const slideMenu = document.getElementById('slideMenu');
    const menuOverlay = document.getElementById('menuOverlay');
    const hamburgerBtn = document.getElementById('hamburgerBtn');

    slideMenu.classList.remove('active');
    menuOverlay.classList.remove('active');
    hamburgerBtn.classList.remove('active');

    hapticFeedback('light');
}

// === 2x2 Main Menu Grid Handlers ===
document.getElementById('playSquare').addEventListener('click', () => {
    hapticFeedback('medium');
    showScreen('playModeScreen');
});

document.getElementById('practiceSquare').addEventListener('click', () => {
    hapticFeedback('light');
    document.getElementById('aiModeModal').classList.add('active');
});

document.getElementById('comingSoon1').addEventListener('click', () => {
    hapticFeedback('light');
    showNotification('Coming Soon! Stay tuned.');
});

document.getElementById('comingSoon2').addEventListener('click', () => {
    hapticFeedback('light');
    showNotification('Coming Soon! Stay tuned.');
});

// Slide menu buttons
document.getElementById('depositBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('light');
    showScreen('depositScreen');
});

document.getElementById('playAIBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('light');
    startAIGame();
});

// === Play Flow: Mode Select → Budget → Room Browser → Create Room ===

// Play Mode selection
document.querySelectorAll('.play-mode-card').forEach(card => {
    card.addEventListener('click', () => {
        hapticFeedback('medium');
        selectedGameMode = card.dataset.playmode;
        document.getElementById('budgetModeLabel').textContent = 'Mode: ' + (selectedGameMode === 'classic' ? 'Classic' : 'Chaotic');
        showScreen('budgetScreen');
    });
});

// Budget selection — navigate synchronously, then update details
document.querySelectorAll('.budget-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        hapticFeedback('light');
        document.querySelectorAll('.budget-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedBudget = parseInt(btn.dataset.budget);

        // Navigate FIRST — this must never be blocked
        showScreen('roomBrowserScreen');

        // Update toolbar pills (null-safe in case DOM isn't ready)
        try {
            const modeBadge = document.getElementById('roomModeBadge');
            if (modeBadge) {
                modeBadge.textContent = selectedGameMode === 'classic' ? 'Classic' : 'Chaotic';
                modeBadge.className = 'rb-pill rb-pill-mode' + (selectedGameMode === 'chaotic' ? ' chaotic' : '');
            }
            const budgetBadge = document.getElementById('roomBudgetBadge');
            if (budgetBadge) budgetBadge.textContent = '$' + selectedBudget;
        } catch (e) { console.error('Badge update failed:', e); }

        // Request rooms from server and start polling
        try { requestRoomList(); } catch (e) { console.error('Room list request failed:', e); }
        startRoomPolling();
    });
});

// Back buttons for play flow
document.getElementById('backFromPlayMode').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

document.getElementById('backFromBudget').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('playModeScreen');
});

document.getElementById('backFromRoomBrowser').addEventListener('click', () => {
    hapticFeedback('light');
    stopRoomPolling();
    showScreen('budgetScreen');
});

document.getElementById('backFromCreateRoom').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('roomBrowserScreen');
});

// Create Room button (from room browser)
document.getElementById('createRoomBtn').addEventListener('click', () => {
    hapticFeedback('medium');
    if (activeRoom) {
        showNotification('You already have an active room! Cancel it first.');
        return;
    }
    document.getElementById('createRoomModeLabel').textContent = 'Mode: ' + (selectedGameMode === 'classic' ? 'Classic' : 'Chaotic');
    document.querySelectorAll('.create-room-amount-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('confirmCreateRoomBtn').disabled = true;
    selectedBetAmount = 0;
    showScreen('createRoomScreen');
});

// Create Room amount selection
document.querySelectorAll('.create-room-amount-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        hapticFeedback('light');
        document.querySelectorAll('.create-room-amount-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedBetAmount = parseInt(btn.dataset.amount);
        document.getElementById('confirmCreateRoomBtn').disabled = false;
    });
});

// Confirm create room
document.getElementById('confirmCreateRoomBtn').addEventListener('click', () => {
    if (!selectedBetAmount || selectedBetAmount <= 0) {
        showNotification('Please select an amount');
        return;
    }
    if (selectedBetAmount > AppState.user.balance) {
        showNotification('Insufficient balance!');
        hapticFeedback('error');
        return;
    }
    if (activeRoom) {
        showNotification('You already have an active room!');
        return;
    }

    hapticFeedback('medium');

    // Navigate to room browser immediately
    const betAmt = selectedBetAmount;
    const mode = selectedGameMode;
    showScreen('roomBrowserScreen');

    // Create room in background
    setTimeout(() => {
        const roomId = 'R' + Date.now().toString(36);
        activeRoom = {
            id: roomId,
            mode: mode,
            amount: betAmt,
            playerName: AppState.user.name
        };

        // Deduct wager
        updateBalance(AppState.user.balance - betAmt);

        // Send to server
        sendToServer({
            type: 'createGame',
            userId: AppState.user.id,
            betAmount: betAmt,
            gameMode: mode,
            roomId: roomId
        });

        // Refresh room list so pinned room appears
        requestRoomList();
        // Also render own room immediately in case server is slow
        updateRoomBrowser([{
            id: roomId,
            playerName: AppState.user.name,
            mode: mode,
            amount: betAmt,
            playerId: AppState.user.id,
            isSelf: true
        }]);

        showNotification('Room created! -$' + betAmt.toFixed(2));
    }, 50);
});

// Request room list from server
function requestRoomList() {
    sendToServer({
        type: 'getGames',
        gameMode: selectedGameMode,
        maxBudget: selectedBudget
    });
}

function startRoomPolling() {
    stopRoomPolling();
    roomPollingInterval = setInterval(() => {
        try { requestRoomList(); } catch (e) {}
    }, 3000);
}

function stopRoomPolling() {
    if (roomPollingInterval) {
        clearInterval(roomPollingInterval);
        roomPollingInterval = null;
    }
}

// Get initials from player name for avatar
function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
}

// Build a room card element
function buildRoomCard(room, isSelf) {
    const card = document.createElement('div');
    card.className = 'rb-card';

    const modeLabel = room.mode === 'chaotic' ? 'Chaotic' : 'Classic';
    const initials = isSelf ? 'ME' : getInitials(room.playerName);

    let actionsHTML;
    if (isSelf) {
        actionsHTML = `
            <div class="rb-my-actions">
                <span class="rb-status">Waiting</span>
                <button class="rb-cancel" id="cancelMyRoomBtn">Cancel</button>
            </div>`;
    } else {
        actionsHTML = `<button class="rb-join" data-id="${room.id}" data-amt="${room.amount}">Join</button>`;
    }

    card.innerHTML = `
        <div class="rb-avatar">${escapeHtml(initials)}</div>
        <div class="rb-card-info">
            <div class="rb-card-name">${isSelf ? 'Your Room' : escapeHtml(room.playerName)}</div>
            <div class="rb-card-meta">${escapeHtml(modeLabel)}</div>
        </div>
        <div class="rb-card-amount">$${parseFloat(room.amount).toFixed(2)}</div>
        ${actionsHTML}
    `;
    return card;
}

// Update room browser UI
function updateRoomBrowser(rooms) {
    const myRoomSlot = document.getElementById('myRoomSlot');
    const roomList = document.getElementById('roomList');
    const createBtn = document.getElementById('createRoomBtn');
    myRoomSlot.innerHTML = '';
    roomList.innerHTML = '';

    // Separate own room from others
    let myRoom = null;
    const otherRooms = [];
    rooms.forEach(room => {
        if (room.isSelf || room.playerId === AppState.user.id) {
            myRoom = room;
        } else {
            otherRooms.push(room);
        }
    });

    // Render pinned own room
    if (myRoom) {
        const card = buildRoomCard(myRoom, true);
        myRoomSlot.appendChild(card);
        document.getElementById('cancelMyRoomBtn').addEventListener('click', () => cancelMyRoom());
    }

    // Hide create button when user already has a room
    createBtn.style.display = myRoom ? 'none' : '';

    // Sort other rooms by amount (highest first)
    otherRooms.sort((a, b) => b.amount - a.amount);

    if (otherRooms.length === 0 && !myRoom) {
        roomList.innerHTML = `<div class="rb-list-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>
            <span>No rooms yet</span><span>Create one below</span></div>`;
        return;
    }

    if (otherRooms.length === 0) {
        roomList.innerHTML = `<div class="rb-list-empty">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <span>Waiting for players...</span></div>`;
        return;
    }

    otherRooms.forEach(room => {
        const card = buildRoomCard(room, false);
        roomList.appendChild(card);
        card.querySelector('.rb-join').addEventListener('click', () => {
            joinRoom(room.id, room.amount);
        });
    });
}

// Cancel own room — remove immediately, then refund after server confirms
function cancelMyRoom() {
    if (!activeRoom) return;
    hapticFeedback('medium');

    const refundAmount = activeRoom.amount;
    const roomId = activeRoom.id;

    // Remove from UI immediately
    document.getElementById('myRoomSlot').innerHTML = '';
    document.getElementById('createRoomBtn').style.display = '';
    activeRoom = null;

    // Tell server to cancel (server refunds on its end)
    sendToServer({
        type: 'cancelGame',
        userId: AppState.user.id,
        matchId: roomId
    });

    // Refund balance after server processes
    setTimeout(() => {
        updateBalance(AppState.user.balance + refundAmount);
        showNotification('Room cancelled. +$' + refundAmount.toFixed(2) + ' refunded');
    }, 200);
}

// Join a room — non-blocking, no confirm dialog
function joinRoom(roomId, betAmount) {
    if (betAmount > AppState.user.balance) {
        showNotification('Insufficient balance!');
        hapticFeedback('error');
        return;
    }

    hapticFeedback('medium');

    // Disable all join buttons to prevent double-tap
    document.querySelectorAll('.rb-join').forEach(btn => {
        btn.disabled = true;
        btn.textContent = 'Joining...';
    });

    // Deduct wager from balance immediately
    updateBalance(AppState.user.balance - betAmount);

    sendToServer({
        type: 'joinGame',
        userId: AppState.user.id,
        gameId: roomId
    });

    // Timeout — if server doesn't respond in 5s, re-enable buttons and refund
    window._joinTimeout = setTimeout(() => {
        showNotification('Join timed out. Try again.');
        updateBalance(AppState.user.balance + betAmount);
        document.querySelectorAll('.rb-join').forEach(btn => {
            btn.disabled = false;
            btn.textContent = 'Join';
        });
    }, 5000);
}

// === Match Countdown Screen ===

const COUNTDOWN_TOTAL = 10; // must match server COUNTDOWN_SECS
const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // r=52 from SVG

function populateCountdownScreen(data) {
    // Player names & avatars
    const p1Name = data.player1Name || 'Player 1';
    const p2Name = data.player2Name || 'Player 2';

    document.getElementById('mcPlayer1Name').textContent = p1Name;
    document.getElementById('mcPlayer2Name').textContent = p2Name;
    document.getElementById('mcPlayer1Avatar').textContent = getInitials(p1Name);
    document.getElementById('mcPlayer2Avatar').textContent = getInitials(p2Name);

    // Mode & wager
    const mode = data.gameMode || 'classic';
    const modeEl = document.getElementById('mcMode');
    modeEl.textContent = mode === 'chaotic' ? 'Chaotic' : 'Classic';
    modeEl.className = 'mc-mode' + (mode === 'chaotic' ? ' chaotic' : '');

    document.getElementById('mcWager').textContent = '$' + (data.betAmount || 0);

    // Reset countdown ring
    const ring = document.getElementById('mcRingFg');
    ring.style.strokeDasharray = RING_CIRCUMFERENCE;
    ring.style.strokeDashoffset = '0';

    document.getElementById('mcCountdownNum').textContent = COUNTDOWN_TOTAL;
    document.getElementById('mcStatus').textContent = 'Get ready...';
}

function updateCountdownRing(secondsLeft) {
    const num = document.getElementById('mcCountdownNum');
    const ring = document.getElementById('mcRingFg');
    const status = document.getElementById('mcStatus');

    if (num) num.textContent = secondsLeft;

    // Animate ring: full circle → empty as countdown ticks
    if (ring) {
        const fraction = 1 - (secondsLeft / COUNTDOWN_TOTAL);
        ring.style.strokeDasharray = RING_CIRCUMFERENCE;
        ring.style.strokeDashoffset = (fraction * RING_CIRCUMFERENCE).toString();
    }

    if (status) {
        if (secondsLeft <= 3) {
            status.textContent = 'Starting...';
            hapticFeedback('medium');
        } else if (secondsLeft <= 5) {
            status.textContent = 'Almost there...';
        }
    }
}

// Mini paddle ball animation on the Play square
let menuPaddleAnimId = null;
function animateMenuPaddleBall() {
    // Cancel any existing animation first
    if (menuPaddleAnimId) cancelAnimationFrame(menuPaddleAnimId);

    const canvas = document.getElementById('menuPaddleBallIcon');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = 80, h = 80;

    let ballX = 40, ballY = 40, bvx = 1.5, bvy = 2;
    const paddleW = 24, paddleH = 4;
    let p1x = 28, p2x = 28;
    // Realistic movement: each paddle has its own velocity
    let p1vx = 0, p2vx = 0;

    function draw() {
        // Only run if main menu is visible
        const mainMenu = document.getElementById('mainMenu');
        if (!mainMenu || !mainMenu.classList.contains('active')) {
            menuPaddleAnimId = null;
            return;
        }

        ctx.clearRect(0, 0, w, h);

        ballX += bvx;
        ballY += bvy;

        if (ballX < 4 || ballX > w - 4) bvx *= -1;

        // Realistic paddle AI: only chase ball when it's heading toward you
        const p1Target = ballX - paddleW / 2;
        const p2Target = ballX - paddleW / 2;

        // Bottom paddle (p1): reacts when ball moves down (bvy > 0)
        if (bvy > 0) {
            // Ball approaching - track it with slight smoothing
            const diff1 = p1Target - p1x;
            p1vx += diff1 * 0.06;
        } else {
            // Ball going away - drift gently toward center
            p1vx += ((w / 2 - paddleW / 2) - p1x) * 0.01;
        }
        p1vx *= 0.85; // Friction
        p1x += p1vx;

        // Top paddle (p2): reacts when ball moves up (bvy < 0), with more imperfection
        if (bvy < 0) {
            // Ball approaching - track with slower reaction
            const diff2 = p2Target - p2x;
            p2vx += diff2 * 0.045;
        } else {
            // Ball going away - hold position with slight drift
            p2vx += ((w / 2 - paddleW / 2) - p2x) * 0.008;
        }
        p2vx *= 0.82; // Slightly more friction (different feel)
        p2x += p2vx;

        p1x = Math.max(2, Math.min(w - paddleW - 2, p1x));
        p2x = Math.max(2, Math.min(w - paddleW - 2, p2x));

        if (ballY > h - 12 && bvy > 0 && ballX > p1x && ballX < p1x + paddleW) {
            bvy = -Math.abs(bvy);
            bvx += (Math.random() - 0.5) * 0.5;
        }
        if (ballY < 12 && bvy < 0 && ballX > p2x && ballX < p2x + paddleW) {
            bvy = Math.abs(bvy);
            bvx += (Math.random() - 0.5) * 0.5;
        }
        if (ballY < -5 || ballY > h + 5) {
            ballX = 40; ballY = 40;
            bvy = (Math.random() > 0.5 ? 1 : -1) * 2;
            bvx = (Math.random() - 0.5) * 2;
        }

        // Bottom paddle - white
        ctx.fillStyle = '#ffffff';
        const r1 = paddleH / 2;
        ctx.beginPath();
        ctx.moveTo(p1x + r1, h - 10); ctx.lineTo(p1x + paddleW - r1, h - 10);
        ctx.arc(p1x + paddleW - r1, h - 10 + r1, r1, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(p1x + r1, h - 10 + paddleH);
        ctx.arc(p1x + r1, h - 10 + r1, r1, Math.PI / 2, -Math.PI / 2);
        ctx.fill();

        // Top paddle - white
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(p2x + r1, 6); ctx.lineTo(p2x + paddleW - r1, 6);
        ctx.arc(p2x + paddleW - r1, 6 + r1, r1, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(p2x + r1, 6 + paddleH);
        ctx.arc(p2x + r1, 6 + r1, r1, Math.PI / 2, -Math.PI / 2);
        ctx.fill();

        // Ball - white with subtle glow
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 6;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ballX, ballY, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        menuPaddleAnimId = requestAnimationFrame(draw);
    }
    draw();
}

// Start the mini animation when page loads
setTimeout(animateMenuPaddleBall, 100);

document.getElementById('withdrawBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('light');
    showScreen('withdrawScreen');
});

document.getElementById('customizationBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('light');
    // Show screen FIRST, then update UI + start animations after paint
    showScreen('customizationScreen');
    try {
        updateCustomizationUI();
    } catch (e) {
        console.error('Customization UI error:', e);
    }
});

document.getElementById('statsBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('light');
    updateStatsUI();
    showScreen('statsScreen');
});

document.getElementById('leaderboardBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('light');
    showScreen('leaderboardScreen');
    sendToServer({ type: 'getLeaderboard', userId: AppState.user.id });
    document.getElementById('leaderboardList').innerHTML = '<div class="no-data">Loading...</div>';
});

document.getElementById('matchHistoryBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('light');
    showScreen('matchHistoryScreen');
    document.getElementById('matchHistoryList').innerHTML = '<div class="no-data">Loading...</div>';
    sendToServer({ type: 'getMatchHistory', userId: AppState.user.id });
});

document.getElementById('backFromMatchHistory').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

document.getElementById('referralBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('medium');
    showReferralShare();
});

// Back Buttons
document.getElementById('backFromDeposit').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

document.getElementById('backFromCreate').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

document.getElementById('backFromJoin').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

document.getElementById('backFromWithdraw').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

document.getElementById('backToMenuBtn').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
    requestBalance();
});

document.getElementById('changeNameBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('light');
    if (AppState.naming.changesRemaining <= 0) {
        showNotification('No name changes remaining!');
        return;
    }
    const nameInput = document.getElementById('nameInput');
    nameInput.value = AppState.naming.displayName || '';
    document.getElementById('nameChangesLeft').textContent = 'Name changes remaining: ' + AppState.naming.changesRemaining;
    showScreen('nameSetupScreen');
});

document.getElementById('supportBtn').addEventListener('click', () => {
    closeSlideMenu();
    hapticFeedback('light');
    showScreen('supportScreen');
});

document.getElementById('backFromSupport').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

document.getElementById('backFromAdmin').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

// Game Mode Selection
document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        hapticFeedback('medium');

        // Remove selected class from all mode buttons
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('selected'));

        // Add selected class to clicked button
        btn.classList.add('selected');

        // Store selected mode
        selectedGameMode = btn.dataset.mode;

        // Update mode display badge
        const modeBadge = document.getElementById('selectedModeDisplay');
        modeBadge.textContent = selectedGameMode === 'classic' ? 'Classic' : 'Chaotic';
        modeBadge.className = 'mode-badge' + (selectedGameMode === 'chaotic' ? ' chaotic' : '');

        // Hide mode selection, show bet amount selection
        document.getElementById('gameModeSelection').style.display = 'none';
        document.getElementById('betAmountSelection').style.display = 'block';
    });
});

// (Old createGameBtn reset handler removed - replaced by play flow)

// AI Mode Selection Modal
document.querySelectorAll('.ai-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        hapticFeedback('medium');

        // Get selected mode
        const mode = btn.dataset.mode;
        selectedGameMode = mode;

        // Hide modal
        document.getElementById('aiModeModal').classList.remove('active');

        // Start AI game with selected mode
        startAIGame();
    });
});

// Cancel AI mode selection
document.getElementById('cancelAIModeBtn').addEventListener('click', () => {
    hapticFeedback('light');
    document.getElementById('aiModeModal').classList.remove('active');
});

// Preset Bet Amount Selection
document.querySelectorAll('.bet-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        hapticFeedback('light');

        // Remove selected class from all buttons
        document.querySelectorAll('.bet-btn').forEach(b => b.classList.remove('selected'));

        // Add selected class to clicked button
        btn.classList.add('selected');

        // Store selected amount
        selectedBetAmount = parseFloat(btn.dataset.amount);

        // Enable create button
        document.getElementById('confirmCreateBtn').disabled = false;
    });
});

// Create Game
document.getElementById('confirmCreateBtn').addEventListener('click', () => {
    if (!selectedBetAmount || selectedBetAmount <= 0) {
        showNotification('Please select a bet amount');
        return;
    }

    if (selectedBetAmount > AppState.user.balance) {
        showNotification('Insufficient balance');
        return;
    }

    hapticFeedback('medium');

    // Send create game request to server
    sendToServer({
        type: 'createGame',
        userId: AppState.user.id,
        betAmount: selectedBetAmount
    });

    // Show waiting room
    showWaitingRoom(selectedBetAmount);
});

// Request list of available games
function requestGamesList() {
    sendToServer({
        type: 'getGames'
    });
}

// Update games list UI
function updateGamesList(games) {
    const gamesList = document.getElementById('gamesList');
    gamesList.innerHTML = '';

    // Filter games based on selected filter
    const filter = document.getElementById('filterAmount').value;
    const filteredGames = filterGames(games, filter);

    if (filteredGames.length === 0) {
        gamesList.innerHTML = `
            <div class="no-games">
                <p>No games available. Create one!</p>
            </div>
        `;
        return;
    }

    // Create game items
    filteredGames.forEach(game => {
        const gameItem = document.createElement('div');
        gameItem.className = 'game-item';
        gameItem.innerHTML = `
            <div class="game-item-info">
                <div class="game-item-player">${escapeHtml(game.creatorName)}</div>
                <div class="game-item-amount">$${parseFloat(game.betAmount).toFixed(2)}</div>
            </div>
        `;
        const joinBtn = document.createElement('button');
        joinBtn.className = 'game-item-btn';
        joinBtn.textContent = 'Join';
        joinBtn.addEventListener('click', () => joinGame(game.id, game.betAmount));
        gameItem.querySelector('.game-item-info').after(joinBtn);
        gamesList.appendChild(gameItem);
    });
}

// Filter games based on amount
function filterGames(games, filter) {
    if (filter === 'all') {
        return games;
    }

    return games.filter(game => {
        const amount = game.betAmount;
        switch (filter) {
            case 'low':
                return amount >= 1 && amount <= 10;
            case 'medium':
                return amount > 10 && amount <= 50;
            case 'high':
                return amount > 50;
            default:
                return true;
        }
    });
}

// Join game
function joinGame(gameId, betAmount) {
    // Legacy join — redirect to the new joinRoom flow
    joinRoom(gameId, betAmount);
}

// Filter change listener
document.getElementById('filterAmount').addEventListener('change', () => {
    requestGamesList();
});

// Copy deposit address
document.getElementById('copyAddressBtn').addEventListener('click', () => {
    const address = document.getElementById('depositAddress').textContent;

    if (navigator.clipboard) {
        navigator.clipboard.writeText(address).then(() => {
            hapticFeedback('success');
            showNotification('Address copied!');
        }).catch(err => {
            console.error('Failed to copy:', err);
        });
    } else {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = address;
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            hapticFeedback('success');
            showNotification('Address copied!');
        } catch (err) {
            console.error('Failed to copy:', err);
        }
        document.body.removeChild(textArea);
    }
});

// Confirm deposit
document.getElementById('confirmDepositBtn').addEventListener('click', () => {
    const amount = parseFloat(document.getElementById('depositAmountInput').value);

    if (!amount || amount <= 0) {
        showNotification('Please enter a valid amount');
        return;
    }

    hapticFeedback('medium');

    // In production, this would interact with TON wallet
    showNotification('Deposit feature will be integrated with TON wallet');

    // For testing: simulate deposit
    sendToServer({
        type: 'deposit',
        userId: AppState.user.id,
        amount: amount
    });

    document.getElementById('depositAmountInput').value = '';
});

// Confirm withdrawal
document.getElementById('confirmWithdrawBtn').addEventListener('click', () => {
    const address = document.getElementById('withdrawAddress').value.trim();
    const amount = parseFloat(document.getElementById('withdrawAmount').value);

    if (!address) {
        showNotification('Please enter a wallet address');
        return;
    }

    if (!amount || amount <= 0) {
        showNotification('Please enter a valid amount');
        return;
    }

    if (amount > AppState.user.balance) {
        showNotification('Insufficient balance');
        return;
    }

    hapticFeedback('medium');

    showConfirm(`Withdraw $${amount.toFixed(2)} to ${address.substring(0, 10)}...?`, (confirmed) => {
        if (confirmed) {
            sendToServer({
                type: 'withdraw',
                userId: AppState.user.id,
                address: address,
                amount: amount
            });

            document.getElementById('withdrawAddress').value = '';
            document.getElementById('withdrawAmount').value = '';

            showNotification('Withdrawal request submitted');
            showScreen('mainMenu');
        }
    });
});

// Waiting Room Functions
function showWaitingRoom(betAmount) {
    currentMatchId = 'M' + Date.now().toString(36);

    document.getElementById('waitingBetAmount').textContent = betAmount.toFixed(2);
    document.getElementById('waitingMatchId').textContent = currentMatchId;

    showScreen('waitingRoomScreen');

    // Start 10-second countdown
    startWaitingCountdown();
}

function startWaitingCountdown() {
    let seconds = 10;
    const countdownElement = document.getElementById('countdownSeconds');

    waitingRoomTimer = setInterval(() => {
        seconds--;
        countdownElement.textContent = seconds;

        if (seconds <= 0) {
            clearInterval(waitingRoomTimer);
            document.getElementById('waitingCountdown').style.display = 'none';
        }
    }, 1000);
}

// Cancel Waiting
document.getElementById('cancelWaitingBtn').addEventListener('click', () => {
    hapticFeedback('medium');

    if (waitingRoomTimer) {
        clearInterval(waitingRoomTimer);
    }

    // Refund wager to balance
    if (activeRoom && activeRoom.amount) {
        updateBalance(AppState.user.balance + activeRoom.amount);
        showNotification('Room cancelled. +$' + activeRoom.amount.toFixed(2) + ' refunded');
    }

    // Clear active room
    activeRoom = null;

    sendToServer({
        type: 'cancelGame',
        userId: AppState.user.id,
        matchId: currentMatchId
    });

    showScreen('mainMenu');
});

// Invite Friend
document.getElementById('inviteFriendBtn').addEventListener('click', () => {
    hapticFeedback('medium');

    const inviteUrl = `https://t.me/yourbot?start=join_${currentMatchId}`;

    if (AppState.telegram && AppState.telegram.shareUrl) {
        AppState.telegram.shareUrl(inviteUrl, 'Join my Paddle Ball game!');
    } else {
        // Fallback - copy to clipboard
        if (navigator.clipboard) {
            navigator.clipboard.writeText(inviteUrl);
            showNotification('Invite link copied to clipboard!');
        } else {
            showNotification('Share link: ' + inviteUrl);
        }
    }
});

// Rematch Functions — multiplayer rematch via server offer
function startRematchCountdown() {
    let seconds = 30;
    const countdownSpan = document.getElementById('rematchCountdown');
    if (countdownSpan) countdownSpan.textContent = seconds;

    if (rematchTimer) clearInterval(rematchTimer);
    rematchTimer = setInterval(() => {
        seconds--;
        if (countdownSpan) countdownSpan.textContent = seconds;
        if (seconds <= 0) {
            clearInterval(rematchTimer);
            rematchTimer = null;
            const rematchSection = document.getElementById('rematchSection');
            if (rematchSection) rematchSection.style.display = 'none';
        }
    }, 1000);
}

// Rematch Button — send offer to opponent via server
document.getElementById('rematchBtn').addEventListener('click', () => {
    hapticFeedback('medium');

    if (rematchTimer) {
        clearInterval(rematchTimer);
        rematchTimer = null;
    }
    const rematchSection = document.getElementById('rematchSection');
    if (rematchSection) rematchSection.style.display = 'none';

    const matchId = window._lastMatchId || currentMatchId;
    sendToServer({
        type: 'requestRematch',
        userId: AppState.user.id,
        matchId: matchId
    });
});

// Rematch Offer Banner — shown when opponent sends a rematch offer
let _rematchOfferTimer = null;
let _pendingRematchId = null;

function showRematchOfferBanner(data) {
    _pendingRematchId = data.rematchId;
    const banner = document.getElementById('rematchOfferBanner');
    const nameEl  = document.getElementById('rematchOfferName');
    const detailsEl = document.getElementById('rematchOfferDetails');
    const timerEl  = document.getElementById('rematchOfferTimer');
    if (!banner) return;

    if (nameEl) nameEl.textContent = data.requesterName || 'Opponent';
    if (detailsEl) detailsEl.textContent = data.gameMode + ' · $' + (data.betAmount || 0).toFixed(2);
    if (timerEl) timerEl.textContent = '30s';

    banner.style.display = 'block';

    let secs = 30;
    if (_rematchOfferTimer) clearInterval(_rematchOfferTimer);
    _rematchOfferTimer = setInterval(() => {
        secs--;
        if (timerEl) timerEl.textContent = secs + 's';
        if (secs <= 0) {
            clearInterval(_rematchOfferTimer);
            _rematchOfferTimer = null;
            hideRematchOfferBanner();
        }
    }, 1000);

    hapticFeedback('medium');
}

function hideRematchOfferBanner() {
    const banner = document.getElementById('rematchOfferBanner');
    if (banner) banner.style.display = 'none';
    if (_rematchOfferTimer) { clearInterval(_rematchOfferTimer); _rematchOfferTimer = null; }
    _pendingRematchId = null;
}

document.getElementById('rematchAcceptBtn').addEventListener('click', () => {
    hapticFeedback('medium');
    if (!_pendingRematchId) return;
    sendToServer({ type: 'rematchAccept', userId: AppState.user.id, rematchId: _pendingRematchId });
    hideRematchOfferBanner();
});

document.getElementById('rematchDeclineBtn').addEventListener('click', () => {
    hapticFeedback('light');
    if (!_pendingRematchId) return;
    sendToServer({ type: 'rematchDecline', userId: AppState.user.id, rematchId: _pendingRematchId });
    hideRematchOfferBanner();
});

// Report Match
document.getElementById('reportMatchBtn').addEventListener('click', () => {
    hapticFeedback('light');

    // Pre-fill match ID
    document.getElementById('reportMatchId').value = currentMatchId;

    showScreen('supportScreen');
});

// Submit Report
document.getElementById('submitReportBtn').addEventListener('click', () => {
    const matchId = document.getElementById('reportMatchId').value.trim();
    const description = document.getElementById('reportDescription').value.trim();

    if (!description) {
        showNotification('Please describe the issue');
        return;
    }

    hapticFeedback('medium');

    sendToServer({
        type: 'submitReport',
        userId: AppState.user.id,
        matchId: matchId || 'N/A',
        description: description,
        timestamp: Date.now()
    });

    showNotification('Report submitted. Thank you!');

    // Clear form
    document.getElementById('reportMatchId').value = '';
    document.getElementById('reportDescription').value = '';

    setTimeout(() => {
        showScreen('mainMenu');
    }, 1500);
});

// Admin Panel - Tab Switching
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;

        // Update active tab button
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Show corresponding tab content
        document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));
        document.getElementById(tabName + 'Tab').classList.add('active');

        hapticFeedback('light');
    });
});

// Admin - Ban User
document.getElementById('confirmBanBtn').addEventListener('click', () => {
    const identifier = document.getElementById('banIdentifier').value.trim();
    const reason = document.getElementById('banReason').value.trim();

    if (!identifier || !reason) {
        showNotification('Please enter ID/IP and reason');
        return;
    }

    hapticFeedback('heavy');

    sendToServer({
        type: 'adminBan',
        adminId: AppState.user.id,
        identifier: identifier,
        reason: reason,
        timestamp: Date.now()
    });

    showNotification('User banned');

    // Clear form
    document.getElementById('banIdentifier').value = '';
    document.getElementById('banReason').value = '';
});

// Helper function to update Match ID in result screen
window.setResultMatchId = function(matchId) {
    currentMatchId = matchId;
    const el = document.getElementById('resultMatchId');
    el.textContent = matchId ? matchId.slice(0, 12) + '…' : '---';
    el.onclick = () => {
        navigator.clipboard.writeText(matchId).then(() => {
            el.textContent = 'Copied!';
            setTimeout(() => { el.textContent = matchId ? matchId.slice(0, 12) + '…' : '---'; }, 1500);
        }).catch(() => {});
    };
};

// AI Game Functions
function startAIGame() {
    // Go directly to game screen
    showScreen('gameScreen');

    // Immediately update status so user never sees "Waiting for opponent..."
    document.getElementById('gameStatus').textContent = 'Practice Mode - Loading...';

    currentMatchId = 'AI' + Date.now().toString(36);

    // Set up AI game
    const aiGameData = {
        id: currentMatchId,
        player1Id: AppState.user.id,
        player1Name: AppState.user.name,
        player2Id: 'AI',
        player2Name: 'AI Opponent',
        betAmount: 0,
        isAIGame: true,
        gameMode: selectedGameMode
    };

    initGame(aiGameData);

    setTimeout(() => {
        startGame(aiGameData);
    }, 1000);
}

// Back button handlers for new screens
document.getElementById('backFromCustomization').addEventListener('click', () => {
    hapticFeedback('light');
    stopAllPaddlePreviews();
    showScreen('mainMenu');
});

document.getElementById('backFromStats').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

document.getElementById('backFromLeaderboard').addEventListener('click', () => {
    hapticFeedback('light');
    showScreen('mainMenu');
});

// === Paddle Customization System (Animated Previews - Lightweight) ===

// Animation state
let previewAnimId = null;
let previewRunning = false;
const PREVIEW_FPS = 16;
const PREVIEW_INTERVAL = 1000 / PREVIEW_FPS;
let previewLastFrame = 0;

// Cached canvas contexts (avoid DOM lookup every frame)
const previewCache = {};

// Sakura petal particles (persistent, recycled)
const sakuraPetals = [];
for (let i = 0; i < 5; i++) {
    sakuraPetals.push({
        x: Math.random() * 80, y: Math.random() * 50,
        vy: 0.15 + Math.random() * 0.2,
        rot: Math.random() * 6.28, rotSpd: (Math.random() - 0.5) * 0.02,
        size: 1.5 + Math.random() * 2, alpha: 0.3 + Math.random() * 0.4
    });
}

// Draw capsule shape path (no shadowBlur anywhere)
function previewCapsulePath(ctx, px, py, pw, ph) {
    const r = ph / 2;
    ctx.beginPath();
    ctx.moveTo(px + r, py);
    ctx.lineTo(px + pw - r, py);
    ctx.arc(px + pw - r, py + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(px + r, py + ph);
    ctx.arc(px + r, py + r, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
}

// Get or create cached context for a skin
function getPreviewCtx(skinName) {
    if (previewCache[skinName]) return previewCache[skinName];
    const canvas = document.getElementById(skinName + 'Preview');
    if (!canvas) return null;
    const entry = { canvas: canvas, ctx: canvas.getContext('2d') };
    previewCache[skinName] = entry;
    return entry;
}

// Draw animated skin preview - NO shadowBlur, lightweight effects only
function drawSkinPreview(skinName, t) {
    const c = getPreviewCtx(skinName);
    if (!c) return;
    const ctx = c.ctx;
    const cw = c.canvas.width, ch = c.canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    const px = cw / 2 - 40, py = ch / 2 - 8, pw = 80, ph = 16;

    switch (skinName) {
        case 'basic': {
            // Pearl white with sliding shimmer
            const shimX = ((t / 8) % (pw + 30)) - 15;
            const grad = ctx.createLinearGradient(px, py, px + pw, py);
            grad.addColorStop(0, '#d4c5b0');
            grad.addColorStop(0.3, '#ede4d8');
            grad.addColorStop(0.5, '#f5efe8');
            grad.addColorStop(0.7, '#ede4d8');
            grad.addColorStop(1, '#d4c5b0');
            previewCapsulePath(ctx, px, py, pw, ph);
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth = 1;
            ctx.stroke();
            // Sliding highlight
            ctx.save();
            previewCapsulePath(ctx, px, py, pw, ph);
            ctx.clip();
            const shGrad = ctx.createLinearGradient(px + shimX - 10, py, px + shimX + 10, py);
            shGrad.addColorStop(0, 'rgba(255,255,255,0)');
            shGrad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
            shGrad.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = shGrad;
            ctx.fillRect(px + shimX - 10, py, 20, ph);
            ctx.restore();
            break;
        }
        case 'frost': {
            // Icy gradient with animated crystals
            const grad = ctx.createLinearGradient(px, py, px + pw, py);
            grad.addColorStop(0, '#a5d8ff');
            grad.addColorStop(0.3, '#e7f5ff');
            grad.addColorStop(0.5, '#ffffff');
            grad.addColorStop(0.7, '#e7f5ff');
            grad.addColorStop(1, '#a5d8ff');
            previewCapsulePath(ctx, px, py, pw, ph);
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.8)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            // Animated frost crystals (grow/shrink) - bigger & faster
            for (let i = 0; i < 6; i++) {
                const cx = px + ((i + 0.5) / 6) * pw;
                const crystalH = 3 + Math.sin(t / 3 + i * 1.2) * 4;
                ctx.strokeStyle = 'rgba(165,216,255,' + (0.5 + Math.sin(t / 4 + i) * 0.3) + ')';
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(cx, py); ctx.lineTo(cx - 1.5, py - crystalH); ctx.lineTo(cx + 1.5, py - crystalH); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(cx, py + ph); ctx.lineTo(cx - 1.5, py + ph + crystalH); ctx.lineTo(cx + 1.5, py + ph + crystalH); ctx.stroke();
            }
            // Floating ice motes - bigger, faster, more visible
            for (let i = 0; i < 4; i++) {
                const mx = px + 8 + ((t / 5 + i * 22) % 64);
                const my = py - 5 - Math.sin(t / 6 + i * 2) * 5;
                const ma = 0.5 + Math.sin(t / 4 + i) * 0.3;
                ctx.fillStyle = 'rgba(200,230,255,' + ma + ')';
                ctx.beginPath();
                ctx.arc(mx, my, 2, 0, 6.28);
                ctx.fill();
            }
            break;
        }
        case 'void': {
            // Dark core with pulsing purple
            previewCapsulePath(ctx, px, py, pw, ph);
            ctx.fillStyle = '#0a0015';
            ctx.fill();
            // Pulsing inner gradient
            const pulseA = 0.3 + Math.sin(t / 5) * 0.15;
            const vGrad = ctx.createRadialGradient(px + pw / 2, py + ph / 2, 0, px + pw / 2, py + ph / 2, pw / 2);
            vGrad.addColorStop(0, 'rgba(15,0,30,0.8)');
            vGrad.addColorStop(0.6, 'rgba(60,0,120,' + pulseA + ')');
            vGrad.addColorStop(1, 'rgba(124,58,237,0.15)');
            previewCapsulePath(ctx, px, py, pw, ph);
            ctx.fillStyle = vGrad;
            ctx.fill();
            // Pulsing border
            ctx.strokeStyle = 'rgba(167,139,250,' + (0.5 + Math.sin(t / 4) * 0.2) + ')';
            ctx.lineWidth = 2;
            previewCapsulePath(ctx, px, py, pw, ph);
            ctx.stroke();
            // Rotating gravitational rings
            for (let r = 0; r < 2; r++) {
                const ringOff = Math.sin(t / 6 + r * 3) * 3;
                ctx.strokeStyle = 'rgba(124,58,237,' + (0.2 - r * 0.06) + ')';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.ellipse(px + pw / 2, py + ph / 2 + ringOff, pw / 2 + 4 + r * 4, ph / 2 + 4 + r * 3, 0, 0, 6.28);
                ctx.stroke();
            }
            // Void wisps pulled inward
            for (let i = 0; i < 3; i++) {
                const angle = t / 8 + i * 2.1;
                const dist = 12 + Math.sin(t / 3 + i) * 4;
                const wx = px + pw / 2 + Math.cos(angle) * dist;
                const wy = py + ph / 2 + Math.sin(angle) * (dist * 0.5);
                ctx.fillStyle = 'rgba(167,139,250,0.4)';
                ctx.beginPath();
                ctx.arc(wx, wy, 1.5, 0, 6.28);
                ctx.fill();
            }
            break;
        }
        case 'sakura': {
            // Pink gradient with shimmer
            const shimmer = 0.15 + Math.sin(t / 4) * 0.1;
            const grad = ctx.createLinearGradient(px, py, px + pw, py);
            grad.addColorStop(0, '#ffc0cb');
            grad.addColorStop(0.3, '#ffb6c1');
            grad.addColorStop(0.5, '#fff0f5');
            grad.addColorStop(0.7, '#ffb6c1');
            grad.addColorStop(1, '#ffc0cb');
            previewCapsulePath(ctx, px, py, pw, ph);
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            // Animated shimmer highlight
            previewCapsulePath(ctx, px + 8, py + 2, pw - 16, ph / 3);
            ctx.fillStyle = 'rgba(255,255,255,' + shimmer + ')';
            ctx.fill();
            // Falling cherry blossom petals - faster fall & drift
            for (let i = 0; i < sakuraPetals.length; i++) {
                const p = sakuraPetals[i];
                p.y += p.vy * 2.5;
                p.x += Math.sin(p.y * 0.08 + i) * 0.5;
                p.rot += p.rotSpd * 2;
                if (p.y > 50) { p.y = -3; p.x = Math.random() * 80; }
                ctx.save();
                ctx.translate(px + p.x, py + ph + 3 + p.y);
                ctx.rotate(p.rot);
                ctx.fillStyle = 'rgba(255,182,193,' + p.alpha + ')';
                ctx.beginPath();
                ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, 6.28);
                ctx.fill();
                ctx.restore();
            }
            break;
        }
        case 'solar': {
            // Blazing radial with animated flares
            const grad = ctx.createRadialGradient(px + pw / 2, py + ph / 2, 0, px + pw / 2, py + ph / 2, pw / 2);
            grad.addColorStop(0, '#fff8e1');
            grad.addColorStop(0.3, '#ffd54f');
            grad.addColorStop(0.7, '#ff8f00');
            grad.addColorStop(1, '#e65100');
            previewCapsulePath(ctx, px, py, pw, ph);
            ctx.fillStyle = grad;
            ctx.fill();
            // Rotating corona flares - faster rotation & pulse
            for (let i = 0; i < 7; i++) {
                const angle = (i / 7) * 6.28 + t / 15;
                const len = 5 + Math.sin(t / 3 + i * 1.5) * 3;
                const fx = px + pw / 2 + Math.cos(angle) * (pw / 2.2);
                const fy = py + ph / 2 + Math.sin(angle) * (ph / 1.5);
                ctx.strokeStyle = 'rgba(255,183,77,' + (0.5 + Math.sin(t / 3 + i) * 0.3) + ')';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(fx, fy);
                ctx.lineTo(fx + Math.cos(angle) * len, fy + Math.sin(angle) * len);
                ctx.stroke();
            }
            // Pulsing core glow
            const coreA = 0.25 + Math.sin(t / 3) * 0.15;
            previewCapsulePath(ctx, px + pw * 0.25, py + 2, pw * 0.5, ph / 3);
            ctx.fillStyle = 'rgba(255,255,255,' + coreA + ')';
            ctx.fill();
            // Floating solar sparks - faster orbit
            for (let i = 0; i < 3; i++) {
                const sa = t / 6 + i * 2.1;
                const sd = 14 + Math.sin(t / 4 + i * 3) * 5;
                const sx = px + pw / 2 + Math.cos(sa) * sd;
                const sy = py + ph / 2 + Math.sin(sa) * (sd * 0.4);
                ctx.fillStyle = 'rgba(255,200,50,' + (0.4 + Math.sin(t / 3 + i) * 0.2) + ')';
                ctx.beginPath();
                ctx.arc(sx, sy, 1.3, 0, 6.28);
                ctx.fill();
            }
            break;
        }
    }
}

// Animation loop - 16fps, lightweight
let previewFrameCount = 0;
function previewAnimLoop(timestamp) {
    if (!previewRunning) { previewAnimId = null; return; }
    if (timestamp - previewLastFrame < PREVIEW_INTERVAL) {
        previewAnimId = requestAnimationFrame(previewAnimLoop);
        return;
    }
    previewLastFrame = timestamp;
    previewFrameCount++;
    const skins = ['basic', 'frost', 'void', 'sakura', 'solar'];
    for (let i = 0; i < skins.length; i++) {
        try { drawSkinPreview(skins[i], previewFrameCount); } catch (e) { /* skip broken frame */ }
    }
    previewAnimId = requestAnimationFrame(previewAnimLoop);
}

function startAllPaddlePreviews() {
    if (previewRunning) return;
    previewRunning = true;
    previewFrameCount = 0;
    previewLastFrame = 0;
    // Clear cache in case canvases were replaced
    for (const k in previewCache) delete previewCache[k];
    previewAnimId = requestAnimationFrame(previewAnimLoop);
}

function stopAllPaddlePreviews() {
    previewRunning = false;
    if (previewAnimId) { cancelAnimationFrame(previewAnimId); previewAnimId = null; }
}

// Customization UI Update
function updateCustomizationUI() {
    // Start animated previews (stops existing if any)
    stopAllPaddlePreviews();
    setTimeout(startAllPaddlePreviews, 100);

    const isUnlocked = (skin) => skin === 'default' || AppState.customization.unlockedSkins.includes(skin);
    const currentSkin = AppState.customization.selectedSkin || 'default';

    // Helper: set up equip button
    function setupEquipBtn(btnId, skinId, cardId, owned) {
        const btn = document.getElementById(btnId);
        const card = document.getElementById(cardId);
        if (!btn || !card) return;

        const isEquipped = currentSkin === skinId;
        card.classList.toggle('equipped', isEquipped);

        if (owned) {
            btn.disabled = isEquipped;
            btn.textContent = isEquipped ? 'Equipped' : 'Equip';
            btn.style.display = '';
        } else {
            btn.disabled = true;
            btn.textContent = 'Locked';
        }

        if (!btn.hasAttribute('data-init')) {
            btn.addEventListener('click', () => {
                if (selectPaddleSkin(skinId)) {
                    updateCustomizationUI();
                    hapticFeedback('light');
                }
            });
            btn.setAttribute('data-init', 'true');
        }
    }

    // Helper: set up try button (equips skin without owning it - temporary)
    function setupTryBtn(btnId, skinId) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        if (!btn.hasAttribute('data-init')) {
            btn.addEventListener('click', () => {
                // Force-equip the skin for testing (bypass ownership check)
                AppState.customization.selectedSkin = skinId;
                if (typeof Game !== 'undefined') Game.paddleSkin = skinId;
                hapticFeedback('light');
                showNotification(skinId === 'default' ? 'Trying: Basic' : 'Trying: ' + skinId.charAt(0).toUpperCase() + skinId.slice(1));
                updateCustomizationUI();
            });
            btn.setAttribute('data-init', 'true');
        }
    }

    // Basic Paddle (always available)
    setupEquipBtn('equipBasic', 'default', 'basicSkinCard', true);
    setupTryBtn('tryBasic', 'default');

    // Frost Paddle (Purchase $10)
    const isFrostOwned = isUnlocked('frost');
    const frostPurchaseBtn = document.getElementById('purchaseFrost');
    if (isFrostOwned) {
        frostPurchaseBtn.style.display = 'none';
    } else {
        frostPurchaseBtn.style.display = '';
        frostPurchaseBtn.textContent = 'Buy $10';
    }
    if (!frostPurchaseBtn.hasAttribute('data-init')) {
        frostPurchaseBtn.addEventListener('click', () => {
            if (purchasePaddle('frost')) {
                updateCustomizationUI();
            }
        });
        frostPurchaseBtn.setAttribute('data-init', 'true');
    }
    setupEquipBtn('equipFrost', 'frost', 'frostSkinCard', isFrostOwned);
    setupTryBtn('tryFrost', 'frost');

    // Void Paddle (Purchase $50)
    const isVoidOwned = isUnlocked('void');
    const voidPurchaseBtn = document.getElementById('purchaseVoid');
    if (isVoidOwned) {
        voidPurchaseBtn.style.display = 'none';
    } else {
        voidPurchaseBtn.style.display = '';
        voidPurchaseBtn.textContent = 'Buy $50';
    }
    if (!voidPurchaseBtn.hasAttribute('data-init')) {
        voidPurchaseBtn.addEventListener('click', () => {
            if (purchasePaddle('void')) {
                updateCustomizationUI();
            }
        });
        voidPurchaseBtn.setAttribute('data-init', 'true');
    }
    setupEquipBtn('equipVoid', 'void', 'voidSkinCard', isVoidOwned);
    setupTryBtn('tryVoid', 'void');

    // Sakura Paddle (Wager Unlock $100)
    const sakuraProgress = getUnlockProgress('sakura');
    document.getElementById('sakuraProgress').textContent = Math.min(sakuraProgress.wagered, sakuraProgress.required).toFixed(2);
    document.getElementById('sakuraProgressBar').style.width = sakuraProgress.progress + '%';
    setupEquipBtn('equipSakura', 'sakura', 'sakuraSkinCard', isUnlocked('sakura'));
    setupTryBtn('trySakura', 'sakura');

    // Solar Paddle (Wager Unlock $500)
    const solarProgress = getUnlockProgress('solar');
    document.getElementById('solarProgress').textContent = Math.min(solarProgress.wagered, solarProgress.required).toFixed(2);
    document.getElementById('solarProgressBar').style.width = solarProgress.progress + '%';
    setupEquipBtn('equipSolar', 'solar', 'solarSkinCard', isUnlocked('solar'));
    setupTryBtn('trySolar', 'solar');
}

// Stats UI Update
function updateStatsUI() {
    const stats = AppState.stats;

    document.getElementById('statWins').textContent = stats.wins;
    document.getElementById('statLosses').textContent = stats.losses;
    document.getElementById('statStreak').textContent = stats.longestStreak;
    document.getElementById('statEarnings').textContent = '$' + stats.totalEarnings.toFixed(2);
    document.getElementById('statWagered').textContent = '$' + stats.totalWagered.toFixed(2);

    const winRate = stats.wins + stats.losses > 0
        ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
        : 0;
    document.getElementById('statWinRate').textContent = winRate + '%';
}

// Active leaderboard tab
let activeLeaderboardTab = 'earnings';

document.querySelectorAll('.leaderboard-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.leaderboard-tabs .tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeLeaderboardTab = btn.dataset.tab;
        if (window._leaderboardData) renderLeaderboard(window._leaderboardData);
    });
});

function renderLeaderboard(data) {
    const list = document.getElementById('leaderboardList');
    list.innerHTML = '';

    let players;
    if (activeLeaderboardTab === 'wins') players = data.byWins;
    else if (activeLeaderboardTab === 'elo') players = data.byElo;
    else players = data.byEarnings;

    if (!players || players.length === 0) {
        list.innerHTML = '<div class="no-data">No players yet — be the first!</div>';
        return;
    }

    players.forEach((player, index) => {
        const item = document.createElement('div');
        const isMe = player.name === AppState.user.name;
        item.className = 'leaderboard-item' + (isMe ? ' highlight' : '');

        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '#' + (index + 1);
        let stat;
        if (activeLeaderboardTab === 'wins') stat = `${player.wins}W / ${player.losses}L`;
        else if (activeLeaderboardTab === 'elo') stat = `${player.elo} ELO`;
        else stat = `+$${(player.earnings || 0).toFixed(2)}`;

        item.innerHTML = `
            <div class="rank">${escapeHtml(medal)}</div>
            <div class="player-name">${escapeHtml(player.name)}${isMe ? ' (You)' : ''}</div>
            <div class="player-stats"><div>${escapeHtml(stat)}</div></div>
        `;
        list.appendChild(item);
    });
}

function renderMatchHistory(history) {
    const list = document.getElementById('matchHistoryList');
    if (!list) return;

    if (!history || history.length === 0) {
        list.innerHTML = '<div class="no-data">No matches played yet — get out there!</div>';
        return;
    }

    list.innerHTML = '';
    history.forEach(match => {
        const item = document.createElement('div');
        item.className = 'mh-item mh-' + match.result;

        const timeAgo = formatTimeAgo(match.timestamp);
        const netSign = match.netChange >= 0 ? '+' : '';
        const netColor = match.result === 'win' ? '#22c55e' : match.result === 'loss' ? '#ef4444' : '#94a3b8';
        const eloSign = match.eloChange > 0 ? '+' : '';
        const eloColor = match.eloChange > 0 ? '#22c55e' : match.eloChange < 0 ? '#ef4444' : '#94a3b8';
        const resultLabel = match.result === 'win' ? 'WIN' : match.result === 'loss' ? 'LOSS' : 'DRAW';
        const modeLabel = match.gameMode === 'chaotic' ? '⚡ Chaotic' : '🎯 Classic';

        item.innerHTML = `
            <div class="mh-result-badge mh-badge-${match.result}">${escapeHtml(resultLabel)}</div>
            <div class="mh-info">
                <div class="mh-opponent">vs <strong>${escapeHtml(match.opponentName)}</strong></div>
                <div class="mh-meta">${escapeHtml(modeLabel)} · $${parseFloat(match.betAmount).toFixed(2)} · ${escapeHtml(timeAgo)}</div>
            </div>
            <div class="mh-right">
                <div class="mh-score">${escapeHtml(match.score)}</div>
                <div class="mh-net" style="color:${netColor}">${netSign}$${Math.abs(match.netChange).toFixed(2)}</div>
                ${match.eloChange !== 0 ? `<div class="mh-elo" style="color:${eloColor}">${eloSign}${match.eloChange} ELO</div>` : ''}
            </div>
        `;
        list.appendChild(item);
    });
}

function formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
}

// Referral share
function showReferralShare() {
    const code = window._myReferralCode;
    if (!code) {
        showNotification('Loading your referral link...');
        return;
    }

    const botName = 'YourBotName'; // replace with actual bot username
    const link = `https://t.me/${botName}?startapp=${code}`;
    const text = `Play against me on GoAgainstMe — skill-based 1v1 for real money! ${link}`;

    if (AppState.telegram && AppState.telegram.openTelegramLink) {
        AppState.telegram.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join me on GoAgainstMe — skill-based 1v1!')}`);
    } else if (navigator.share) {
        navigator.share({ title: 'GoAgainstMe', text, url: link }).catch(() => {});
    } else if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(() => showNotification('Referral link copied!'));
    }
}

// === Main Menu Background Animation (Canvas-based particles) ===
(function initMenuBg() {
    const canvas = document.getElementById('menuBgCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let bgAnimId = null;
    const particles = [];
    const lines = [];

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // Create floating particles
    for (let i = 0; i < 35; i++) {
        particles.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            vx: (Math.random() - 0.5) * 0.4,
            vy: (Math.random() - 0.5) * 0.3,
            size: 1 + Math.random() * 2.5,
            alpha: 0.1 + Math.random() * 0.3,
            color: Math.random() > 0.7 ? 'gold' : 'teal' // Mix of teal and gold
        });
    }

    // Create slow-moving diagonal lines
    for (let i = 0; i < 4; i++) {
        lines.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            length: 60 + Math.random() * 80,
            angle: Math.PI * 0.2 + Math.random() * 0.2,
            speed: 0.2 + Math.random() * 0.3,
            alpha: 0.03 + Math.random() * 0.04
        });
    }

    function drawMenuBg() {
        const w = canvas.width;
        const h = canvas.height;
        const now = Date.now();

        ctx.clearRect(0, 0, w, h);

        // Draw slow-moving diagonal lines (subtle streaks of light)
        for (const line of lines) {
            line.x += Math.cos(line.angle) * line.speed;
            line.y += Math.sin(line.angle) * line.speed;

            // Wrap around
            if (line.x > w + 100) line.x = -100;
            if (line.x < -100) line.x = w + 100;
            if (line.y > h + 100) line.y = -100;
            if (line.y < -100) line.y = h + 100;

            const endX = line.x + Math.cos(line.angle) * line.length;
            const endY = line.y + Math.sin(line.angle) * line.length;

            const grad = ctx.createLinearGradient(line.x, line.y, endX, endY);
            grad.addColorStop(0, `rgba(79, 209, 197, 0)`);
            grad.addColorStop(0.5, `rgba(79, 209, 197, ${line.alpha})`);
            grad.addColorStop(1, `rgba(79, 209, 197, 0)`);

            ctx.strokeStyle = grad;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(line.x, line.y);
            ctx.lineTo(endX, endY);
            ctx.stroke();
        }

        // Draw floating particles
        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;

            // Wrap around
            if (p.x < -10) p.x = w + 10;
            if (p.x > w + 10) p.x = -10;
            if (p.y < -10) p.y = h + 10;
            if (p.y > h + 10) p.y = -10;

            const twinkle = Math.sin(now / 800 + p.x * 0.01 + p.y * 0.01) * 0.15;
            const a = Math.max(0, p.alpha + twinkle);

            if (p.color === 'gold') {
                ctx.fillStyle = `rgba(251, 191, 36, ${a})`;
            } else {
                ctx.fillStyle = `rgba(79, 209, 197, ${a})`;
            }
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        }

        // Subtle connection lines between close particles (network effect)
        ctx.lineWidth = 0.5;
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 120) {
                    const lineAlpha = (1 - dist / 120) * 0.06;
                    ctx.strokeStyle = `rgba(79, 209, 197, ${lineAlpha})`;
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.stroke();
                }
            }
        }

        bgAnimId = requestAnimationFrame(drawMenuBg);
    }

    // Only run when main menu is visible
    const observer = new MutationObserver(() => {
        const mainMenu = document.getElementById('mainMenu');
        if (mainMenu && mainMenu.classList.contains('active')) {
            if (!bgAnimId) {
                bgAnimId = requestAnimationFrame(drawMenuBg);
            }
        } else {
            if (bgAnimId) {
                cancelAnimationFrame(bgAnimId);
                bgAnimId = null;
            }
        }
    });

    const mainMenu = document.getElementById('mainMenu');
    if (mainMenu) {
        observer.observe(mainMenu, { attributes: true, attributeFilter: ['class'] });
        // Start if already active
        if (mainMenu.classList.contains('active')) {
            bgAnimId = requestAnimationFrame(drawMenuBg);
        }
    }
})();

// Grace period countdown overlay shown when opponent disconnects
let _graceInterval = null;
let _graceBanner = null;

window.startGraceCountdown = function(secs) {
    window.clearGraceCountdown();
    let remaining = secs;

    _graceBanner = document.createElement('div');
    _graceBanner.id = 'graceBanner';
    _graceBanner.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
        'background:rgba(0,0,0,0.85);color:#fff;padding:20px 32px;border-radius:14px;' +
        'font-size:1.1rem;font-weight:700;z-index:8000;text-align:center;border:1px solid #4fd1c5;';
    _graceBanner.innerHTML = `<div>Opponent disconnected</div><div id="graceTimer" style="font-size:2rem;margin-top:8px;color:#4fd1c5;">${remaining}s</div><div style="font-size:0.8rem;opacity:0.6;margin-top:4px;">Waiting for reconnect...</div>`;
    document.body.appendChild(_graceBanner);

    _graceInterval = setInterval(() => {
        remaining--;
        const el = document.getElementById('graceTimer');
        if (el) el.textContent = remaining + 's';
        if (remaining <= 0) window.clearGraceCountdown();
    }, 1000);
};

window.clearGraceCountdown = function() {
    if (_graceInterval) { clearInterval(_graceInterval); _graceInterval = null; }
    if (_graceBanner) { _graceBanner.remove(); _graceBanner = null; }
    const el = document.getElementById('graceBanner');
    if (el) el.remove();
};

// ── Confetti ──────────────────────────────────────────────────────────────────
window.launchConfetti = function() {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    canvas.style.display = 'block';
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');

    const COLORS = ['#4ade80','#fbbf24','#60a5fa','#f472b6','#a78bfa','#34d399','#fb923c'];
    const pieces = [];
    for (let i = 0; i < 120; i++) {
        pieces.push({
            x: Math.random() * canvas.width,
            y: -10 - Math.random() * 200,
            w: 6 + Math.random() * 8,
            h: 3 + Math.random() * 4,
            color: COLORS[Math.floor(Math.random() * COLORS.length)],
            vx: (Math.random() - 0.5) * 4,
            vy: 2 + Math.random() * 4,
            rot: Math.random() * 360,
            rotV: (Math.random() - 0.5) * 8,
            alpha: 1
        });
    }

    let frame = 0;
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;
        for (const p of pieces) {
            p.x   += p.vx;
            p.y   += p.vy;
            p.rot += p.rotV;
            p.vy  += 0.08; // gravity
            if (frame > 80) p.alpha -= 0.018;
            if (p.alpha > 0 && p.y < canvas.height + 20) {
                alive = true;
                ctx.save();
                ctx.globalAlpha = Math.max(0, p.alpha);
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot * Math.PI / 180);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            }
        }
        frame++;
        if (alive) {
            requestAnimationFrame(draw);
        } else {
            canvas.style.display = 'none';
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }
    draw();
};
