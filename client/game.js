// Paddle Ball Game Logic - Real-time multiplayer game

// SFX is defined at the bottom of this file (const SFX = { ... })

// Seeded PRNG (mulberry32) — both clients use the same seed → same ball trajectories
function mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Server virtual world dimensions — used to scale server coords to canvas pixels
const SERVER_WORLD_W = 400, SERVER_WORLD_H = 600, SERVER_PADDLE_W = 96;

// roundRect polyfill for older browsers
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
        if (typeof r === 'number') r = [r, r, r, r];
        const [tl, tr, br, bl] = r;
        this.moveTo(x + tl, y);
        this.lineTo(x + w - tr, y);
        this.quadraticCurveTo(x + w, y, x + w, y + tr);
        this.lineTo(x + w, y + h - br);
        this.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
        this.lineTo(x + bl, y + h);
        this.quadraticCurveTo(x, y + h, x, y + h - bl);
        this.lineTo(x, y + tl);
        this.quadraticCurveTo(x, y, x + tl, y);
        this.closePath();
        return this;
    };
}

const Game = {
    canvas: null,
    ctx: null,
    isActive: false,
    isPlayer1: true, // Are we player 1 or player 2
    gameId: null,
    isAIGame: false, // Is this an AI game
    matchSeed: 0,    // Shared seed for deterministic ball RNG

    // Game objects
    ball: {
        x: 0,
        y: 0,
        radius: 8,
        speedX: 0,
        speedY: 0,
        maxSpeed: 17.25, // +15% base speed
        trail: [], // Trail effect for flashy visuals
        rampUpMultiplier: 0.3, // Start at 30% speed (70% slower)
        rampUpStartTime: 0,
        rampUpDuration: 3000, // 3 seconds to reach full speed
        hitCount: 0, // Track hits for non-compounding speed increase
        baseSpeed: 11, // Starting speed for hit % calculation
        accumulatedSpeedPct: 0 // Tracks actual accumulated speed % for HUD display
    },

    // Particle system for flashy effects
    particles: [],

    // Game mode (classic or chaotic)
    gameMode: 'classic', // 'classic' or 'chaotic'

    // Chaotic mode features (skill-based)
    chaotic: {
        hitCount: 0,          // Tracks hits for acceleration
        baseSpeed: 12.94,     // Starting ball speed
        speedBoost: 0,        // Accumulated speed increase
        paddle1Width: 96,     // Current paddle1 width (shrinks)
        paddle2Width: 96,     // Current paddle2 width (shrinks)
        multiBalls: [],       // Extra balls
        nextMultiBall: 0,     // Timer for next multi-ball
        multiBallActive: false,
        screenShake: 0,       // Screen shake intensity (decays)
        bgPulse: 0,           // Background pulse on hits (decays)
        warningAlpha: 0,      // Warning glow before multi-ball
        edgeGlow: 0,          // Edge glow intensity
        sparks: [],           // Chaotic spark particles
        ballSizePhase: 0,     // Ball size oscillation
        // Pickup/boost system
        pickup: null,          // Current floating pickup on field {type, x, y, vx, vy, spawnTime}
        activeBoost: null,     // Currently active boost {type, startTime, duration}
        nextPickupTime: 0      // When next pickup spawns
    },

    // Paddle customization
    paddleSkin: 'default', // 'default', 'frost', 'void', 'sakura', 'solar'

    // Particle systems for paddle effects
    skinParticles: [],

    // Background particles
    bgParticles: [],
    bgInitialized: false,

    paddle1: {
        x: 0,
        y: 0,
        width: 96,
        height: 16,
        speed: 10
    },

    paddle2: {
        x: 0,
        y: 0,
        width: 96,
        height: 16,
        speed: 10
    },

    // Game state
    score: {
        player1: 0,
        player2: 0
    },
    currentRound: 1,
    maxRounds: 3,
    roundActive: false,

    // Round timer (40 seconds per round)
    roundTimeRemaining: 40,
    roundTimerInterval: null,

    // Round wins tracking (best of 3 rounds)
    roundWins: { player1: 0, player2: 0 },

    // Game timer (5 minutes overall)
    gameTimeRemaining: 300,
    gameTimerInterval: null,
    animFrameId: null,

    // Touch controls
    touchX: null,
    isTouching: false,

    // Mouse controls
    mouseX: null,
    isMouseControl: false
};

// Initialize game
function initGame(gameData) {
    console.log('[GAME] initGame called', gameData);

    Game.canvas = document.getElementById('gameCanvas');
    Game.ctx = Game.canvas.getContext('2d');
    Game.gameId = gameData.id;
    Game.isPlayer1 = gameData.player1Id === AppState.user.id;
    Game.isAIGame = gameData.isAIGame || false;
    Game.gameMode = gameData.gameMode || 'classic';
    Game.matchSeed = gameData.ballSeed || (Date.now() & 0xFFFFFF);
    console.log('[ROLE] myId=' + AppState.user.id +
        ' p1Id=' + gameData.player1Id + ' p2Id=' + gameData.player2Id +
        ' isPlayer1=' + Game.isPlayer1 + ' matchSeed=' + Game.matchSeed);
    console.log('[MAP] local=' + (Game.isPlayer1 ? 'bottom(paddle1)' : 'bottom(paddle2)') +
        ' remote=' + (Game.isPlayer1 ? 'top(paddle2)' : 'top(paddle1)'));

    // Initialize chaotic mode state
    if (Game.gameMode === 'chaotic') {
        Game.chaotic.hitCount = 0;
        Game.chaotic.speedBoost = 0;
        Game.chaotic.paddle1Width = 96;
        Game.chaotic.paddle2Width = 96;
        Game.chaotic.multiBalls = [];
        Game.chaotic.multiBallActive = false;
        Game.chaotic.nextMultiBall = 0;
        Game.chaotic.screenShake = 0;
        Game.chaotic.bgPulse = 0;
        Game.chaotic.warningAlpha = 0;
        Game.chaotic.edgeGlow = 0;
        Game.chaotic.sparks = [];
        Game.chaotic.ballSizePhase = 0;
        Game.chaotic.pickup = null;
        Game.chaotic.activeBoost = null;
        Game.chaotic.nextPickupTime = 0;
    }

    // Set canvas size
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Initialize positions
    resetBallAndPaddles();

    // Update player names
    document.getElementById('player1Name').textContent = gameData.player1Name || 'Player 1';
    document.getElementById('player2Name').textContent = gameData.player2Name || 'Player 2';

    // Set up touch controls
    setupTouchControls();

    // Update game status
    document.getElementById('gameStatus').textContent = 'Get ready...';

    // Reset per-match flags
    _gameplayStarted = false;
    _loopTickCount = 0;

    console.log('[GAME] initGame complete. You are player', Game.isPlayer1 ? '1' : '2');
}

// Start game
function startGame(gameData) {
    console.log('Starting game:', gameData);

    Game.isActive = true;
    Game.roundActive = false; // Wait for countdown
    Game.roundTimeRemaining = 40; // 40s per round

    // Reset scores, round counter, and round wins
    Game.score.player1 = 0;
    Game.score.player2 = 0;
    Game.currentRound = 1;
    Game.roundWins = { player1: 0, player2: 0 };
    document.getElementById('player1Score').textContent = '0';
    document.getElementById('player2Score').textContent = '0';
    document.getElementById('currentRound').textContent = '1';

    // Clear ball trail from previous game
    Game.ball.trail = [];

    // Stop any existing game loop before starting a new one
    if (Game.animFrameId) {
        cancelAnimationFrame(Game.animFrameId);
    }

    // Stop any existing game timer
    if (Game.gameTimerInterval) {
        clearInterval(Game.gameTimerInterval);
        Game.gameTimerInterval = null;
    }

    // Start game loop (renders background during countdown)
    gameLoop();

    // Initialize sound system
    SFX.init();

    // Update status
    document.getElementById('gameStatus').textContent = 'Get ready...';
    hapticFeedback('medium');

    // Show 3-second countdown before starting (uses race overlay)
    const overlay = document.getElementById('raceOverlay');
    const numEl = document.getElementById('raceNumber');
    const labelEl = document.getElementById('raceLabel');

    if (!overlay || !numEl) {
        // Fallback — start immediately if overlay missing
        Game.roundActive = true;
        startGameTimer();
        startRound();
        return;
    }

    overlay.classList.add('active');
    if (labelEl) labelEl.textContent = 'GET READY';

    let countdown = 3;
    numEl.textContent = countdown;
    numEl.className = 'race-number';
    numEl.style.animation = 'none';
    numEl.offsetHeight;
    numEl.style.animation = '';

    const countdownInterval = setInterval(() => {
        countdown--;

        if (countdown > 0) {
            numEl.textContent = countdown;
            numEl.className = 'race-number';
            numEl.style.animation = 'none';
            numEl.offsetHeight;
            numEl.style.animation = '';
            hapticFeedback('light');
            SFX.play('countdown');
        } else if (countdown === 0) {
            numEl.textContent = 'GO!';
            numEl.className = 'race-number go';
            numEl.style.animation = 'none';
            numEl.offsetHeight;
            numEl.style.animation = '';
            hapticFeedback('medium');
            SFX.play('go');
        } else {
            clearInterval(countdownInterval);
            overlay.classList.remove('active');
            numEl.className = 'race-number';

            // NOW start the actual game
            Game.roundActive = true;
            startGameTimer();
            startRound();
            document.getElementById('gameStatus').textContent = 'Game started!';
        }
    }, 1000);
}

// Game Timer - now shows per-round 40s countdown in the info bar
function startGameTimer() {
    const timerElement = document.getElementById('gameTimer');
    timerElement.textContent = '40s';

    // The round timer updates are handled by startRound() interval
    // and drawGameHUD() updates the timerElement each frame
    // This function now just sets up initial display
}

// Handle time up
function handleTimeUp() {
    Game.roundActive = false;
    Game.isActive = false;

    hapticFeedback('heavy');

    // Determine winner by current score
    const winner = Game.score.player1 > Game.score.player2 ? 1 : (Game.score.player2 > Game.score.player1 ? 2 : 0);

    if (winner === 0) {
        // Tie - return bets
        showNotification('Time up! Game tied - bets returned');
        setTimeout(() => {
            showScreen('mainMenu');
        }, 2000);
    } else {
        // Someone is ahead
        sendToServer({
            type: 'gameTimeout',
            gameId: Game.gameId,
            winnerId: Game.isPlayer1 ? (winner === 1 ? AppState.user.id : null) : (winner === 2 ? AppState.user.id : null)
        });
    }
}

// Start a new round
function startRound() {
    resetBallAndPaddles();

    // Reset hit counter
    Game.ball.hitCount = 0;
    Game.ball.accumulatedSpeedPct = 0;

    // ── Multiplayer path: signal server we're ready; wait for roundStart ──────
    if (!Game.isAIGame) {
        Game.roundActive = false; // activated by onRoundStart when server responds
        const gameId = AppState.currentGame && AppState.currentGame.id;
        if (gameId) sendToServer({ type: 'roundReady', gameId, userId: AppState.user.id });
        console.log('[ROUND] sent roundReady, waiting for roundStart from server');
        document.getElementById('gameStatus').textContent = 'Syncing...';
        return;
    }

    // ── AI path: start locally ────────────────────────────────────────────────
    Game.roundActive = true;

    // Initialize speed ramp-up (start at 30% speed, reach 100% in 3 seconds)
    Game.ball.rampUpMultiplier = 0.3;
    Game.ball.rampUpStartTime = Date.now();

    // Reset chaotic mode state for new round
    if (Game.gameMode === 'chaotic') {
        Game.chaotic.hitCount = 0;
        Game.chaotic.speedBoost = 0;
        Game.chaotic.paddle1Width = 96;
        Game.chaotic.paddle2Width = 96;
        Game.paddle1.width = 96;
        Game.paddle2.width = 96;
        Game.chaotic.multiBalls = [];
        Game.chaotic.multiBallActive = false;
        Game.chaotic.nextMultiBall = Date.now() + 15000;
        Game.chaotic.screenShake = 0;
        Game.chaotic.bgPulse = 0;
        Game.chaotic.warningAlpha = 0;
        Game.chaotic.edgeGlow = 0;
        Game.chaotic.sparks = [];
        Game.chaotic.ballSizePhase = 0;
        Game.chaotic.pickup = null;
        Game.chaotic.activeBoost = null;
        Game.chaotic.nextPickupTime = Date.now() + 4000;
    }

    // Set initial ball direction — seeded PRNG for deterministic AI trajectory
    const roundSeed = (Game.matchSeed ^ (Game.currentRound * 9001)) >>> 0;
    const rng = mulberry32(roundSeed);
    const speed = 11;
    const horizontalBias = (rng() - 0.5) * 3.4;
    const verticalSpeed = Math.sqrt(speed * speed - horizontalBias * horizontalBias);

    Game.ball.speedX = horizontalBias;
    Game.ball.speedY = (rng() > 0.5 ? -1 : 1) * verticalSpeed;
    console.log('[BALL] serve round=' + Game.currentRound + ' seed=' + roundSeed +
        ' vx=' + Game.ball.speedX.toFixed(2) + ' vy=' + Game.ball.speedY.toFixed(2));

    document.getElementById('gameStatus').textContent = 'Round ' + Game.currentRound + ' of 3';

    // Start 40-second round timer (AI only — server owns this for MP)
    Game.roundTimeRemaining = 40;
    if (Game.roundTimerInterval) clearInterval(Game.roundTimerInterval);
    Game.roundTimerInterval = setInterval(() => {
        if (!Game.roundActive) return;
        Game.roundTimeRemaining--;
        if (Game.roundTimeRemaining <= 0) {
            clearInterval(Game.roundTimerInterval);
            Game.roundTimerInterval = null;
            handleRoundResult('tie');
        }
    }, 1000);
}

// Update AI paddle
function updateAIPaddle() {
    if (!Game.isAIGame || !Game.roundActive) return;

    const aiPaddle = Game.paddle2; // AI is always player 2

    // AI follows the ball with some delay/imperfection
    const paddleCenter = aiPaddle.x + aiPaddle.width / 2;
    const ballX = Game.ball.x;

    const diff = ballX - paddleCenter;
    const moveSpeed = 6; // AI speed (slightly slower than max)

    if (Math.abs(diff) > 5) {
        if (diff > 0) {
            aiPaddle.x += moveSpeed;
        } else {
            aiPaddle.x -= moveSpeed;
        }
    }

    // Keep paddle within bounds
    if (aiPaddle.x < 0) aiPaddle.x = 0;
    if (aiPaddle.x > Game.canvas.width - aiPaddle.width) {
        aiPaddle.x = Game.canvas.width - aiPaddle.width;
    }
}

// Chaotic mode - skill-based mechanics
function updateChaoticMode() {
    if (Game.gameMode !== 'chaotic' || !Game.roundActive) return;

    const now = Date.now();

    // Multi-ball mechanic: spawns extra ball every 20s for 6s
    if (!Game.chaotic.multiBallActive && now >= Game.chaotic.nextMultiBall) {
        Game.chaotic.multiBallActive = true;

        // Spawn a second ball from center - 40% slower overall, starts 60% slower, ramps to full in 2s
        const speed = (10.06 + Game.chaotic.speedBoost * 0.5) * 0.6;
        const mbSX = (Math.random() - 0.5) * 2.4;
        const mbSY = (Math.random() > 0.5 ? -1 : 1) * speed;
        Game.chaotic.multiBalls.push({
            x: Game.canvas.width / 2,
            y: Game.canvas.height / 2,
            speedX: mbSX,
            speedY: mbSY,
            baseSpeedX: mbSX,
            baseSpeedY: mbSY,
            radius: 6,
            life: 6000,
            spawnTime: now,
            trail: [],
            paddleHits: 0,
            rampUp: 0.4, // Start at 40% speed (60% slower)
            rampDuration: 2000, // 2 seconds to reach full speed
            preSpawnDuration: 800, // 800ms pop-in animation before ball launches
            launched: false
        });

        createParticles(Game.canvas.width / 2, Game.canvas.height / 2, 'rgba(255, 100, 100, 1)', 20);
        hapticFeedback('medium');
        SFX.play('multiBall');
    }

    // Update multi-balls
    Game.chaotic.multiBalls = Game.chaotic.multiBalls.filter(mb => {
        if (now - mb.spawnTime > mb.life) {
            Game.chaotic.multiBallActive = false;
            Game.chaotic.nextMultiBall = now + 15000 + Math.random() * 5000;
            return false;
        }

        // Pre-spawn phase: ball stays at center during pop-in animation
        const mbElapsed = now - mb.spawnTime;
        if (mbElapsed < mb.preSpawnDuration) {
            // Don't move during pre-spawn - ball sits at center with arrow
            mb.launched = false;
            return true; // keep in array but skip movement
        }

        // Mark as launched and ramp up speed
        mb.launched = true;
        const launchElapsed = mbElapsed - mb.preSpawnDuration;
        if (launchElapsed < mb.rampDuration) {
            mb.rampUp = 0.4 + 0.6 * (launchElapsed / mb.rampDuration);
        } else {
            mb.rampUp = 1.0;
        }

        // Move multi-ball
        mb.x += mb.speedX * mb.rampUp;
        mb.y += mb.speedY * mb.rampUp;

        // Trail
        mb.trail.push({ x: mb.x, y: mb.y });
        if (mb.trail.length > 6) mb.trail.shift();

        // Wall collision
        if (mb.x - mb.radius < 0 || mb.x + mb.radius > Game.canvas.width) {
            mb.speedX *= -1;
        }

        // Paddle collisions for multi-ball (disappears after 2 hits)
        if (mb.y + mb.radius > Game.paddle1.y &&
            mb.y + mb.radius < Game.paddle1.y + Game.paddle1.height &&
            mb.x > Game.paddle1.x && mb.x < Game.paddle1.x + Game.paddle1.width) {
            mb.speedY = -Math.abs(mb.speedY);
            mb.paddleHits++;
            if (mb.paddleHits >= 2) {
                // Subtle pop effect: small ring burst + particles
                createParticles(mb.x, mb.y, 'rgba(255, 150, 150, 0.8)', 10);
                Game.chaotic.sparks.push(
                    ...Array.from({ length: 8 }, () => ({
                        x: mb.x, y: mb.y,
                        vx: (Math.random() - 0.5) * 5, vy: (Math.random() - 0.5) * 5,
                        life: 12 + Math.random() * 8, maxLife: 20,
                        r: 255, g: 120, b: 120
                    }))
                );
                Game.chaotic.multiBallActive = false;
                Game.chaotic.nextMultiBall = now + 15000 + Math.random() * 5000;
                return false;
            }
        }
        if (mb.y - mb.radius < Game.paddle2.y + Game.paddle2.height &&
            mb.y - mb.radius > Game.paddle2.y &&
            mb.x > Game.paddle2.x && mb.x < Game.paddle2.x + Game.paddle2.width) {
            mb.speedY = Math.abs(mb.speedY);
            mb.paddleHits++;
            if (mb.paddleHits >= 2) {
                createParticles(mb.x, mb.y, 'rgba(255, 150, 150, 0.8)', 10);
                Game.chaotic.sparks.push(
                    ...Array.from({ length: 8 }, () => ({
                        x: mb.x, y: mb.y,
                        vx: (Math.random() - 0.5) * 5, vy: (Math.random() - 0.5) * 5,
                        life: 12 + Math.random() * 8, maxLife: 20,
                        r: 255, g: 120, b: 120
                    }))
                );
                Game.chaotic.multiBallActive = false;
                Game.chaotic.nextMultiBall = now + 15000 + Math.random() * 5000;
                return false;
            }
        }

        // Multi-ball scoring = wins the round
        if (mb.y - mb.radius < 0) {
            createParticles(mb.x, mb.y, 'rgba(255, 100, 100, 1)', 10);
            SFX.play('score');
            Game.chaotic.multiBallActive = false;
            handleRoundResult('player1');
            return false;
        }
        if (mb.y + mb.radius > Game.canvas.height) {
            createParticles(mb.x, mb.y, 'rgba(255, 100, 100, 1)', 10);
            SFX.play('scoreLost');
            Game.chaotic.multiBallActive = false;
            handleRoundResult('player2');
            return false;
        }

        return true;
    });

    // Shrink paddles gradually (skill: precision gets harder)
    const minWidth = 50;
    if (Game.chaotic.paddle1Width > minWidth) {
        Game.paddle1.width = Game.chaotic.paddle1Width;
    }
    if (Game.chaotic.paddle2Width > minWidth) {
        Game.paddle2.width = Game.chaotic.paddle2Width;
    }

    // === PICKUP / BOOST SYSTEM ===
    // Boost types: emoji, name, duration in ms, effect applied in applyBoost/updateBoost
    const BOOST_TYPES = [
        { id: 'speed',   emoji: '🔥', name: 'Speed Surge',    duration: 4000 },
        { id: 'wind',    emoji: '💨', name: 'Wind Gust',      duration: 5000 },
        { id: 'ghost',   emoji: '👻', name: 'Ghost Ball',     duration: 4000 },
        { id: 'shrink',  emoji: '📏', name: 'Shrink Paddles', duration: 5000 },
        { id: 'curve',   emoji: '🌀', name: 'Curve Ball',     duration: 4000 },
        { id: 'mega',    emoji: '⚡', name: 'Mega Ball',      duration: 3000 }
    ];

    // Spawn a new pickup if none exists and timer elapsed
    if (!Game.chaotic.pickup && now >= Game.chaotic.nextPickupTime) {
        const type = BOOST_TYPES[Math.floor(Math.random() * BOOST_TYPES.length)];
        const margin = 60;
        Game.chaotic.pickup = {
            type: type,
            x: margin + Math.random() * (Game.canvas.width - margin * 2),
            y: Game.canvas.height * 0.25 + Math.random() * (Game.canvas.height * 0.5),
            vx: (Math.random() - 0.5) * 0.6,
            vy: (Math.random() - 0.5) * 0.4,
            spawnTime: now,
            life: 10000 // 10 seconds on screen
        };
    }

    // Update pickup position, check for collection, handle expiry
    if (Game.chaotic.pickup) {
        const p = Game.chaotic.pickup;
        const age = now - p.spawnTime;

        // Gentle floating movement
        p.x += p.vx;
        p.y += p.vy;

        // Bounce off walls gently
        if (p.x < 30 || p.x > Game.canvas.width - 30) p.vx *= -1;
        if (p.y < Game.canvas.height * 0.15 || p.y > Game.canvas.height * 0.85) p.vy *= -1;

        // Check if ball collects the pickup (distance < 30)
        const dx = Game.ball.x - p.x;
        const dy = Game.ball.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 30) {
            // Collected! Activate boost (swap if one is already active)
            Game.chaotic.activeBoost = {
                type: p.type,
                startTime: now,
                duration: p.type.duration,
                windDir: Math.random() > 0.5 ? 1 : -1, // for wind boost
                curveDir: (Math.random() - 0.5) * 0.6   // for curve boost
            };
            Game.chaotic.pickup = null;
            Game.chaotic.nextPickupTime = now + 3000 + Math.random() * 2000; // 3-5s until next
            createParticles(p.x, p.y, 'rgba(255, 220, 50, 1)', 15);
            SFX.play('multiBall');
            hapticFeedback('light');
        } else if (age >= p.life) {
            // Expired without being collected
            Game.chaotic.pickup = null;
            Game.chaotic.nextPickupTime = now + 3000 + Math.random() * 2000;
        }
    }

    // Apply active boost effects
    if (Game.chaotic.activeBoost) {
        const b = Game.chaotic.activeBoost;
        const elapsed = now - b.startTime;

        if (elapsed >= b.duration) {
            // Boost expired - revert any ongoing effects
            if (b.type.id === 'shrink') {
                // Paddles return to their chaotic width (not boost-shrunk)
                Game.paddle1.width = Game.chaotic.paddle1Width;
                Game.paddle2.width = Game.chaotic.paddle2Width;
            }
            Game.chaotic.activeBoost = null;
        } else {
            // Apply ongoing effect each frame
            switch (b.type.id) {
                case 'speed':
                    // Ball moves 40% faster
                    Game.ball.speedX *= 1.003;
                    Game.ball.speedY *= 1.003;
                    break;
                case 'wind':
                    // Strong sideways wind
                    Game.ball.speedX += b.windDir * 0.25;
                    break;
                case 'ghost':
                    // Handled in drawBall (reduced visibility)
                    break;
                case 'shrink':
                    // Both paddles shrink 30%
                    Game.paddle1.width = Game.chaotic.paddle1Width * 0.7;
                    Game.paddle2.width = Game.chaotic.paddle2Width * 0.7;
                    break;
                case 'curve':
                    // Constant curve drift on the ball
                    Game.ball.speedX += b.curveDir * 0.15;
                    break;
                case 'mega':
                    // Ball is bigger + faster (handled in drawBall for size)
                    Game.ball.speedX *= 1.004;
                    Game.ball.speedY *= 1.004;
                    break;
            }
        }
    }

    // Ball size oscillation (pulsing ball radius)
    Game.chaotic.ballSizePhase += 0.03;
}

// Draw chaotic mode visuals
function drawChaoticVisuals() {
    if (Game.gameMode !== 'chaotic') return;

    const w = Game.canvas.width;
    const h = Game.canvas.height;
    const now = Date.now();

    // Decay visual effects
    Game.chaotic.screenShake *= 0.9;
    if (Game.chaotic.screenShake < 0.3) Game.chaotic.screenShake = 0;
    Game.chaotic.bgPulse *= 0.92;
    Game.chaotic.edgeGlow = Math.min(1, Game.chaotic.hitCount * 0.05);

    // Screen shake - subtle translate
    if (Game.chaotic.screenShake > 0.5) {
        const shakeX = (Math.random() - 0.5) * Game.chaotic.screenShake;
        const shakeY = (Math.random() - 0.5) * Game.chaotic.screenShake;
        Game.ctx.translate(shakeX, shakeY);
    }

    // Subtle background pulse on hits (no white flash)
    if (Game.chaotic.bgPulse > 0.05) {
        const intensity = Game.chaotic.bgPulse;
        const hue = (Game.chaotic.hitCount * 30) % 360;
        Game.ctx.fillStyle = `hsla(${hue}, 70%, 50%, ${intensity * 0.04})`;
        Game.ctx.fillRect(0, 0, w, h);
    }

    // Edge glow lines that intensify with speed
    if (Game.chaotic.edgeGlow > 0.05) {
        const eg = Game.chaotic.edgeGlow;
        const pulse = Math.sin(now / 200) * 0.3 + 0.7;

        const leftGrad = Game.ctx.createLinearGradient(0, 0, 25, 0);
        leftGrad.addColorStop(0, `rgba(255, 50, 50, ${eg * pulse * 0.2})`);
        leftGrad.addColorStop(1, 'rgba(255, 50, 50, 0)');
        Game.ctx.fillStyle = leftGrad;
        Game.ctx.fillRect(0, 0, 25, h);

        const rightGrad = Game.ctx.createLinearGradient(w - 25, 0, w, 0);
        rightGrad.addColorStop(0, 'rgba(255, 50, 50, 0)');
        rightGrad.addColorStop(1, `rgba(255, 50, 50, ${eg * pulse * 0.2})`);
        Game.ctx.fillStyle = rightGrad;
        Game.ctx.fillRect(w - 25, 0, 25, h);
    }

    // Draw floating pickup - sharp, video-game inspired visuals
    if (Game.chaotic.pickup) {
        const p = Game.chaotic.pickup;
        const age = now - p.spawnTime;

        // Fade out over last 3s
        let alpha = 1;
        if (age > 7000) {
            alpha = 1 - ((age - 7000) / 3000);
        }

        // Sharp pop-in animation (first 400ms) - snappy, no bubble
        let popScale = 1;
        let popAlpha = alpha;
        if (age < 400) {
            const t = age / 400;
            // Sharp elastic: fast overshoot then snap
            popScale = t < 0.4
                ? t * 2.5 * 1.2  // 0 -> 1.2 fast
                : 1.2 - (t - 0.4) * 0.33; // 1.2 -> 1.0
            popAlpha = Math.min(1, t * 3) * alpha;
        }

        // Subtle hover oscillation
        const hover = Math.sin(now / 350) * 3;
        const spin = now / 800; // Rotation speed

        Game.ctx.save();
        Game.ctx.translate(p.x, p.y + hover);
        Game.ctx.scale(popScale, popScale);

        // Get boost-specific colors and draw sharp icon
        const boostId = p.type.id;
        let mainColor, glowColor, accentColor;

        switch (boostId) {
            case 'speed':  mainColor = '#ff4422'; glowColor = '#ff6644'; accentColor = '#ffaa33'; break;
            case 'wind':   mainColor = '#22aaff'; glowColor = '#44ccff'; accentColor = '#88ddff'; break;
            case 'ghost':  mainColor = '#aa88ff'; glowColor = '#ccaaff'; accentColor = '#eeddff'; break;
            case 'shrink': mainColor = '#ff44aa'; glowColor = '#ff66cc'; accentColor = '#ffaadd'; break;
            case 'curve':  mainColor = '#44ff88'; glowColor = '#66ffaa'; accentColor = '#aaffcc'; break;
            case 'mega':   mainColor = '#ffcc00'; glowColor = '#ffdd44'; accentColor = '#ffee88'; break;
            default:       mainColor = '#ffffff'; glowColor = '#cccccc'; accentColor = '#eeeeee';
        }

        // Outer glow
        Game.ctx.shadowColor = glowColor;
        Game.ctx.shadowBlur = 18 + Math.sin(now / 120) * 5;

        // Diamond/crystal container shape (rotates)
        Game.ctx.save();
        Game.ctx.rotate(spin * 0.3);

        // Outer diamond border
        Game.ctx.strokeStyle = `rgba(255, 255, 255, ${popAlpha * 0.5})`;
        Game.ctx.lineWidth = 1.5;
        Game.ctx.beginPath();
        const dSize = 22;
        Game.ctx.moveTo(0, -dSize);
        Game.ctx.lineTo(dSize, 0);
        Game.ctx.lineTo(0, dSize);
        Game.ctx.lineTo(-dSize, 0);
        Game.ctx.closePath();
        Game.ctx.stroke();

        // Filled inner diamond
        Game.ctx.fillStyle = `rgba(0, 0, 0, ${popAlpha * 0.6})`;
        Game.ctx.fill();

        Game.ctx.restore();

        // Inner icon drawn on top (no rotation - stays readable)
        Game.ctx.shadowBlur = 12;
        Game.ctx.shadowColor = glowColor;

        switch (boostId) {
            case 'speed':
                // Sharp upward arrow / flame
                Game.ctx.fillStyle = `rgba(255, 68, 34, ${popAlpha})`;
                Game.ctx.beginPath();
                Game.ctx.moveTo(0, -12);
                Game.ctx.lineTo(7, 2);
                Game.ctx.lineTo(3, 0);
                Game.ctx.lineTo(4, 10);
                Game.ctx.lineTo(0, 5);
                Game.ctx.lineTo(-4, 10);
                Game.ctx.lineTo(-3, 0);
                Game.ctx.lineTo(-7, 2);
                Game.ctx.closePath();
                Game.ctx.fill();
                // Hot core
                Game.ctx.fillStyle = `rgba(255, 200, 100, ${popAlpha * 0.8})`;
                Game.ctx.beginPath();
                Game.ctx.moveTo(0, -6);
                Game.ctx.lineTo(3, 1);
                Game.ctx.lineTo(0, 4);
                Game.ctx.lineTo(-3, 1);
                Game.ctx.closePath();
                Game.ctx.fill();
                break;

            case 'wind':
                // Three horizontal wind streaks
                Game.ctx.strokeStyle = `rgba(34, 170, 255, ${popAlpha})`;
                Game.ctx.lineWidth = 2.5;
                Game.ctx.lineCap = 'round';
                for (let i = -1; i <= 1; i++) {
                    const yOff = i * 6;
                    const wave = Math.sin(now / 150 + i * 1.5) * 3;
                    Game.ctx.beginPath();
                    Game.ctx.moveTo(-10 + wave, yOff);
                    Game.ctx.lineTo(6 + wave, yOff);
                    Game.ctx.lineTo(10 + wave, yOff - 2);
                    Game.ctx.stroke();
                }
                Game.ctx.lineCap = 'butt';
                break;

            case 'ghost':
                // Ghost silhouette - sharp edged
                const ghostFlicker = Math.sin(now / 80) * 0.2 + 0.7;
                Game.ctx.fillStyle = `rgba(170, 136, 255, ${popAlpha * ghostFlicker})`;
                Game.ctx.beginPath();
                Game.ctx.moveTo(0, -10);
                Game.ctx.quadraticCurveTo(9, -8, 9, 0);
                Game.ctx.lineTo(9, 7);
                Game.ctx.lineTo(6, 4);
                Game.ctx.lineTo(3, 8);
                Game.ctx.lineTo(0, 4);
                Game.ctx.lineTo(-3, 8);
                Game.ctx.lineTo(-6, 4);
                Game.ctx.lineTo(-9, 7);
                Game.ctx.lineTo(-9, 0);
                Game.ctx.quadraticCurveTo(-9, -8, 0, -10);
                Game.ctx.closePath();
                Game.ctx.fill();
                // Eyes
                Game.ctx.fillStyle = `rgba(255, 255, 255, ${popAlpha * 0.9})`;
                Game.ctx.fillRect(-5, -3, 3, 3);
                Game.ctx.fillRect(2, -3, 3, 3);
                break;

            case 'shrink':
                // Inward-pointing arrows (compress)
                Game.ctx.strokeStyle = `rgba(255, 68, 170, ${popAlpha})`;
                Game.ctx.lineWidth = 2.5;
                Game.ctx.lineCap = 'round';
                // Left arrow pointing right
                Game.ctx.beginPath();
                Game.ctx.moveTo(-12, 0); Game.ctx.lineTo(-3, 0);
                Game.ctx.moveTo(-6, -4); Game.ctx.lineTo(-3, 0); Game.ctx.lineTo(-6, 4);
                Game.ctx.stroke();
                // Right arrow pointing left
                Game.ctx.beginPath();
                Game.ctx.moveTo(12, 0); Game.ctx.lineTo(3, 0);
                Game.ctx.moveTo(6, -4); Game.ctx.lineTo(3, 0); Game.ctx.lineTo(6, 4);
                Game.ctx.stroke();
                Game.ctx.lineCap = 'butt';
                break;

            case 'curve':
                // Spiral / vortex
                Game.ctx.strokeStyle = `rgba(68, 255, 136, ${popAlpha})`;
                Game.ctx.lineWidth = 2;
                Game.ctx.beginPath();
                for (let a = 0; a < Math.PI * 3; a += 0.15) {
                    const r = 2 + a * 2.5;
                    const px = Math.cos(a + spin) * r;
                    const py = Math.sin(a + spin) * r;
                    if (a === 0) Game.ctx.moveTo(px, py);
                    else Game.ctx.lineTo(px, py);
                }
                Game.ctx.stroke();
                break;

            case 'mega':
                // Lightning bolt
                Game.ctx.fillStyle = `rgba(255, 204, 0, ${popAlpha})`;
                Game.ctx.beginPath();
                Game.ctx.moveTo(2, -12);
                Game.ctx.lineTo(8, -12);
                Game.ctx.lineTo(2, -2);
                Game.ctx.lineTo(7, -2);
                Game.ctx.lineTo(-3, 12);
                Game.ctx.lineTo(0, 2);
                Game.ctx.lineTo(-5, 2);
                Game.ctx.closePath();
                Game.ctx.fill();
                // Bright core
                Game.ctx.fillStyle = `rgba(255, 255, 200, ${popAlpha * 0.6})`;
                Game.ctx.beginPath();
                Game.ctx.moveTo(3, -8);
                Game.ctx.lineTo(5, -8);
                Game.ctx.lineTo(2, -1);
                Game.ctx.lineTo(4, -1);
                Game.ctx.lineTo(-1, 8);
                Game.ctx.lineTo(1, 1);
                Game.ctx.lineTo(-2, 1);
                Game.ctx.closePath();
                Game.ctx.fill();
                break;
        }

        Game.ctx.shadowBlur = 0;

        // Spawn flash ring (first 300ms)
        if (age < 300) {
            const flashProg = age / 300;
            const flashR = 15 + flashProg * 20;
            Game.ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - flashProg) * 0.6 * popAlpha})`;
            Game.ctx.lineWidth = 2;
            Game.ctx.beginPath();
            Game.ctx.arc(0, 0, flashR, 0, Math.PI * 2);
            Game.ctx.stroke();
        }

        // Corner tick marks (sharp detail)
        const tickDist = 16 + Math.sin(now / 200) * 2;
        Game.ctx.strokeStyle = `rgba(255, 255, 255, ${popAlpha * 0.35})`;
        Game.ctx.lineWidth = 1;
        for (let corner = 0; corner < 4; corner++) {
            const cx = (corner < 2 ? -1 : 1) * tickDist;
            const cy = (corner % 2 === 0 ? -1 : 1) * tickDist;
            Game.ctx.beginPath();
            Game.ctx.moveTo(cx, cy);
            Game.ctx.lineTo(cx + (corner < 2 ? 4 : -4), cy);
            Game.ctx.moveTo(cx, cy);
            Game.ctx.lineTo(cx, cy + (corner % 2 === 0 ? 4 : -4));
            Game.ctx.stroke();
        }

        Game.ctx.restore();
    }

    // Draw active boost indicator (top-left HUD) - sharp style
    if (Game.chaotic.activeBoost) {
        const b = Game.chaotic.activeBoost;
        const elapsed = now - b.startTime;
        const remaining = Math.max(0, b.duration - elapsed);
        const fraction = remaining / b.duration;

        // Boost-specific color
        let boostColor;
        switch (b.type.id) {
            case 'speed':  boostColor = '#ff4422'; break;
            case 'wind':   boostColor = '#22aaff'; break;
            case 'ghost':  boostColor = '#aa88ff'; break;
            case 'shrink': boostColor = '#ff44aa'; break;
            case 'curve':  boostColor = '#44ff88'; break;
            case 'mega':   boostColor = '#ffcc00'; break;
            default:       boostColor = '#ffffff';
        }

        // Badge background
        Game.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        Game.ctx.beginPath();
        Game.ctx.roundRect(8, 88, 110, 28, 6);
        Game.ctx.fill();

        // Colored accent line on left
        Game.ctx.fillStyle = boostColor;
        Game.ctx.fillRect(8, 88, 3, 28);

        // Timer bar
        Game.ctx.fillStyle = fraction > 0.3 ? boostColor : 'rgba(255, 80, 80, 0.8)';
        Game.ctx.globalAlpha = 0.6;
        Game.ctx.beginPath();
        Game.ctx.roundRect(8, 112, 110 * fraction, 4, 2);
        Game.ctx.fill();
        Game.ctx.globalAlpha = 1;

        // Boost name (no emoji)
        Game.ctx.font = 'bold 12px monospace';
        Game.ctx.textAlign = 'left';
        Game.ctx.fillStyle = boostColor;
        Game.ctx.fillText(b.type.name.toUpperCase(), 15, 106);

        // Wind visual streaks if wind boost is active
        if (b.type.id === 'wind') {
            Game.ctx.strokeStyle = 'rgba(100, 200, 255, 0.2)';
            Game.ctx.lineWidth = 1;
            for (let i = 0; i < 6; i++) {
                const yPos = (h * 0.2) + (i / 6) * (h * 0.6);
                const xBase = ((now * 0.2 * b.windDir + i * 70) % w + w) % w;
                Game.ctx.beginPath();
                Game.ctx.moveTo(xBase, yPos);
                Game.ctx.lineTo(xBase + 20 * b.windDir, yPos);
                Game.ctx.stroke();
            }
        }

        // Curve visual indicator
        if (b.type.id === 'curve') {
            Game.ctx.strokeStyle = 'rgba(180, 100, 255, 0.15)';
            Game.ctx.lineWidth = 2;
            const curveDir = b.curveDir > 0 ? 1 : -1;
            Game.ctx.beginPath();
            for (let y = h * 0.15; y < h * 0.85; y += 4) {
                const xOff = Math.sin((y / h) * Math.PI * 3 + now / 300) * 15 * curveDir;
                if (y === h * 0.15) Game.ctx.moveTo(w / 2 + xOff, y);
                else Game.ctx.lineTo(w / 2 + xOff, y);
            }
            Game.ctx.stroke();
        }
    }

    // Warning glow before multi-ball spawns
    if (!Game.chaotic.multiBallActive && Game.chaotic.nextMultiBall > 0) {
        const timeUntil = Game.chaotic.nextMultiBall - now;
        if (timeUntil < 3000 && timeUntil > 0) {
            const urgency = 1 - (timeUntil / 3000);
            const warningPulse = Math.sin(now / (200 - urgency * 150)) * 0.5 + 0.5;
            Game.chaotic.warningAlpha = urgency * warningPulse;

            Game.ctx.strokeStyle = `rgba(255, 100, 100, ${Game.chaotic.warningAlpha * 0.4})`;
            Game.ctx.lineWidth = 2;
            Game.ctx.shadowColor = '#ff4444';
            Game.ctx.shadowBlur = 8;
            const ringRadius = 20 + (1 - urgency) * 30;
            Game.ctx.beginPath();
            Game.ctx.arc(w / 2, h / 2, ringRadius, 0, Math.PI * 2);
            Game.ctx.stroke();
            Game.ctx.shadowBlur = 0;

            if (urgency > 0.5) {
                Game.ctx.font = 'bold 14px monospace';
                Game.ctx.fillStyle = `rgba(255, 100, 100, ${Game.chaotic.warningAlpha * 0.6})`;
                Game.ctx.textAlign = 'center';
                Game.ctx.fillText('!', w / 2, h / 2 + 5);
            }
        }
    }

    // Chaotic sparks
    Game.chaotic.sparks = Game.chaotic.sparks.filter(s => {
        s.life--;
        if (s.life <= 0) return false;
        s.x += s.vx;
        s.y += s.vy;
        s.vy += 0.1;
        const alpha = s.life / s.maxLife;
        Game.ctx.fillStyle = `rgba(${s.r}, ${s.g}, ${s.b}, ${alpha})`;
        Game.ctx.fillRect(s.x, s.y, 2, 2);
        return true;
    });

    // Draw multi-balls
    for (const mb of Game.chaotic.multiBalls) {
        const mbAge = now - mb.spawnTime;

        // === PRE-SPAWN PHASE: pop-in animation with directional arrow ===
        if (!mb.launched && mbAge < mb.preSpawnDuration) {
            const progress = mbAge / mb.preSpawnDuration;

            // Elastic pop-in scale: 0 → 1.3 → 1.0
            let scale;
            if (progress < 0.5) {
                scale = progress * 2 * 1.3; // 0 → 1.3
            } else {
                scale = 1.3 - (progress - 0.5) * 2 * 0.3; // 1.3 → 1.0
            }

            // Pulsing glow ring
            const ringPulse = Math.sin(now / 80) * 0.3 + 0.7;
            const ringRadius = mb.radius * scale + 6 + ringPulse * 4;
            Game.ctx.strokeStyle = `rgba(255, 100, 100, ${0.3 * progress})`;
            Game.ctx.lineWidth = 2;
            Game.ctx.shadowColor = '#ff4444';
            Game.ctx.shadowBlur = 12;
            Game.ctx.beginPath();
            Game.ctx.arc(mb.x, mb.y, ringRadius, 0, Math.PI * 2);
            Game.ctx.stroke();
            Game.ctx.shadowBlur = 0;

            // Draw ball with scale
            Game.ctx.save();
            Game.ctx.translate(mb.x, mb.y);
            Game.ctx.scale(scale, scale);
            Game.ctx.fillStyle = `rgba(255, 120, 120, ${0.5 + progress * 0.5})`;
            Game.ctx.shadowColor = '#ff4444';
            Game.ctx.shadowBlur = 15;
            Game.ctx.beginPath();
            Game.ctx.arc(0, 0, mb.radius, 0, Math.PI * 2);
            Game.ctx.fill();
            // Inner core
            Game.ctx.fillStyle = `rgba(255, 200, 200, ${progress * 0.8})`;
            Game.ctx.beginPath();
            Game.ctx.arc(0, 0, mb.radius * 0.4, 0, Math.PI * 2);
            Game.ctx.fill();
            Game.ctx.shadowBlur = 0;
            Game.ctx.restore();

            // Directional arrow - shows where ball will go
            const arrowAngle = Math.atan2(mb.speedY, mb.speedX);
            const arrowPulse = Math.sin(now / 120) * 0.2 + 0.8;
            const arrowAlpha = progress * arrowPulse;
            const arrowDist = mb.radius * scale + 10;
            const arrowLen = 18 + progress * 8;
            const arrowTipX = mb.x + Math.cos(arrowAngle) * (arrowDist + arrowLen);
            const arrowTipY = mb.y + Math.sin(arrowAngle) * (arrowDist + arrowLen);
            const arrowStartX = mb.x + Math.cos(arrowAngle) * arrowDist;
            const arrowStartY = mb.y + Math.sin(arrowAngle) * arrowDist;

            // Arrow shaft (thick, glowing)
            Game.ctx.strokeStyle = `rgba(255, 160, 160, ${arrowAlpha})`;
            Game.ctx.lineWidth = 3;
            Game.ctx.lineCap = 'round';
            Game.ctx.shadowColor = '#ff6666';
            Game.ctx.shadowBlur = 8;
            Game.ctx.beginPath();
            Game.ctx.moveTo(arrowStartX, arrowStartY);
            Game.ctx.lineTo(arrowTipX, arrowTipY);
            Game.ctx.stroke();

            // Arrow head (larger, more visible)
            const headAngle = 0.45;
            const headLen = 10;
            Game.ctx.lineWidth = 3;
            Game.ctx.beginPath();
            Game.ctx.moveTo(arrowTipX, arrowTipY);
            Game.ctx.lineTo(arrowTipX - Math.cos(arrowAngle - headAngle) * headLen, arrowTipY - Math.sin(arrowAngle - headAngle) * headLen);
            Game.ctx.stroke();
            Game.ctx.beginPath();
            Game.ctx.moveTo(arrowTipX, arrowTipY);
            Game.ctx.lineTo(arrowTipX - Math.cos(arrowAngle + headAngle) * headLen, arrowTipY - Math.sin(arrowAngle + headAngle) * headLen);
            Game.ctx.stroke();
            Game.ctx.lineCap = 'butt';
            Game.ctx.shadowBlur = 0;

            continue; // Skip normal ball rendering during pre-spawn
        }

        // === LAUNCHED BALL: normal rendering, NO arrow ===
        for (let i = 0; i < mb.trail.length; i++) {
            const alpha = (i / mb.trail.length) * 0.4;
            Game.ctx.fillStyle = `rgba(255, 100, 100, ${alpha})`;
            Game.ctx.beginPath();
            Game.ctx.arc(mb.trail[i].x, mb.trail[i].y, mb.radius * (i / mb.trail.length), 0, Math.PI * 2);
            Game.ctx.fill();
        }

        const timeFade = 1 - Math.max(0, (now - mb.spawnTime - mb.life + 1000) / 1000);
        const mbPulse = Math.sin(now / 100) * 0.3 + 0.7;
        // After 1 hit: flicker faster to signal it's about to pop
        const hitFlicker = mb.paddleHits >= 1 ? (Math.sin(now / 40) * 0.4 + 0.6) : 1;
        Game.ctx.fillStyle = `rgba(255, 120, 120, ${Math.min(1, timeFade * hitFlicker)})`;
        Game.ctx.shadowColor = mb.paddleHits >= 1 ? '#ff8888' : '#ff4444';
        Game.ctx.shadowBlur = 12 + mbPulse * 8;
        Game.ctx.beginPath();
        Game.ctx.arc(mb.x, mb.y, mb.radius, 0, Math.PI * 2);
        Game.ctx.fill();

        Game.ctx.fillStyle = `rgba(255, 200, 200, ${Math.min(0.8, timeFade)})`;
        Game.ctx.beginPath();
        Game.ctx.arc(mb.x, mb.y, mb.radius * 0.4, 0, Math.PI * 2);
        Game.ctx.fill();
        Game.ctx.shadowBlur = 0;
    }

    // Hit count display
    if (Game.chaotic.hitCount > 0) {
        Game.ctx.font = '10px monospace';
        Game.ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        Game.ctx.textAlign = 'right';
        Game.ctx.fillText(`Hits: ${Game.chaotic.hitCount}`, w - 10, 78);
    }

    // Reset screen shake transform
    if (Game.chaotic.screenShake > 0.5) {
        Game.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
}

// Update ball physics (AI games only — multiplayer ball is owned by server)
function updateBallPhysics() {
    if (!Game.isAIGame) return;   // MP: server runs physics; client only renders
    if (!Game.roundActive) return;

    // Update gradual speed ramp-up (70% slower -> normal over 3 seconds)
    const now = Date.now();
    const elapsedTime = now - Game.ball.rampUpStartTime;
    if (elapsedTime < Game.ball.rampUpDuration) {
        const progress = elapsedTime / Game.ball.rampUpDuration;
        Game.ball.rampUpMultiplier = 0.3 + (0.7 * progress);
    } else {
        Game.ball.rampUpMultiplier = 1.0;
    }

    // Update chaotic mode
    if (Game.gameMode === 'chaotic') {
        const oldP1Width = Game.paddle1.width;
        const oldP2Width = Game.paddle2.width;
        updateChaoticMode();
        // Re-center paddles after any width change so ball doesn't phase through
        if (Game.paddle1.width !== oldP1Width) {
            const center = Game.paddle1.x + oldP1Width / 2;
            Game.paddle1.x = Math.max(0, Math.min(center - Game.paddle1.width / 2, Game.canvas.width - Game.paddle1.width));
        }
        if (Game.paddle2.width !== oldP2Width) {
            const center = Game.paddle2.x + oldP2Width / 2;
            Game.paddle2.x = Math.max(0, Math.min(center - Game.paddle2.width / 2, Game.canvas.width - Game.paddle2.width));
        }
    }

    // Move ball
    Game.ball.x += Game.ball.speedX * Game.ball.rampUpMultiplier;
    Game.ball.y += Game.ball.speedY * Game.ball.rampUpMultiplier;

    // Wall collision (left/right)
    if (Game.ball.x - Game.ball.radius < 0) {
        Game.ball.x = Game.ball.radius;
        Game.ball.speedX = Math.abs(Game.ball.speedX);
        SFX.play('wall');
        // Chaotic: wall bounce sparks
        if (Game.gameMode === 'chaotic') {
            for (let i = 0; i < 6; i++) {
                Game.chaotic.sparks.push({
                    x: 0, y: Game.ball.y,
                    vx: 1 + Math.random() * 3, vy: (Math.random() - 0.5) * 4,
                    life: 15 + Math.random() * 10, maxLife: 25,
                    r: 255, g: 200 + Math.floor(Math.random() * 55), b: 50
                });
            }
        }
    }
    if (Game.ball.x + Game.ball.radius > Game.canvas.width) {
        Game.ball.x = Game.canvas.width - Game.ball.radius;
        Game.ball.speedX = -Math.abs(Game.ball.speedX);
        SFX.play('wall');
        // Chaotic: wall bounce sparks
        if (Game.gameMode === 'chaotic') {
            for (let i = 0; i < 6; i++) {
                Game.chaotic.sparks.push({
                    x: Game.canvas.width, y: Game.ball.y,
                    vx: -(1 + Math.random() * 3), vy: (Math.random() - 0.5) * 4,
                    life: 15 + Math.random() * 10, maxLife: 25,
                    r: 255, g: 200 + Math.floor(Math.random() * 55), b: 50
                });
            }
        }
    }

    // Ensure ball always has strong vertical movement (prevent horizontal loops)
    const totalSpeed = Math.sqrt(Game.ball.speedX * Game.ball.speedX + Game.ball.speedY * Game.ball.speedY);
    if (Math.abs(Game.ball.speedY) < totalSpeed * 0.4) {
        // Vertical too weak - redistribute speed
        const sign = Game.ball.speedY >= 0 ? 1 : -1;
        Game.ball.speedY = sign * totalSpeed * 0.7;
        const xSign = Game.ball.speedX >= 0 ? 1 : -1;
        Game.ball.speedX = xSign * Math.sqrt(totalSpeed * totalSpeed - Game.ball.speedY * Game.ball.speedY);
    }

    // --- Paddle collision with interpolated sweep detection ---
    // Calculate previous ball position (before this frame's movement)
    const effSX = Game.ball.speedX * Game.ball.rampUpMultiplier;
    const effSY = Game.ball.speedY * Game.ball.rampUpMultiplier;
    const prevBallX = Game.ball.x - effSX;
    const prevBallY = Game.ball.y - effSY;

    // Flat non-compounding speed increase per hit
    // Classic: 8% of baseSpeed per hit | Chaotic: 10% of baseSpeed per hit
    const hitSpeedPct = Game.gameMode === 'chaotic' ? 0.10 : 0.08;

    // --- Player 1 paddle (bottom) ---
    const prevBBottom = prevBallY + Game.ball.radius;
    const currBBottom = Game.ball.y + Game.ball.radius;
    const p1Top = Game.paddle1.y;
    const crossedP1 = prevBBottom <= p1Top && currBBottom >= p1Top;

    // Interpolate x at crossing point for diagonal movement accuracy
    let p1CheckX = Game.ball.x;
    if (crossedP1 && currBBottom !== prevBBottom) {
        const t = (p1Top - prevBBottom) / (currBBottom - prevBBottom);
        p1CheckX = prevBallX + effSX * t;
    }

    // Expand hitbox by ball radius on each side for edge catches
    const p1Left = Game.paddle1.x - Game.ball.radius;
    const p1Right = Game.paddle1.x + Game.paddle1.width + Game.ball.radius;

    if ((crossedP1 || (currBBottom > p1Top && currBBottom < p1Top + Game.paddle1.height)) &&
        p1CheckX > p1Left && p1CheckX < p1Right) {
        Game.ball.y = Game.paddle1.y - Game.ball.radius;

        const hitPos = Math.max(0, Math.min(1, (p1CheckX - Game.paddle1.x) / Game.paddle1.width));
        const maxAngle = Math.PI / 3;
        const spread = (Math.random() - 0.5) * 0.18; // Slight shotgun spread (~±5 degrees)
        const angle = (hitPos - 0.5) * maxAngle + spread;

        Game.ball.hitCount++;
        Game.ball.accumulatedSpeedPct += hitSpeedPct * 100; // Track display %
        const speedIncrease = Game.ball.baseSpeed * hitSpeedPct;
        const currentSpeed = Math.sqrt(Game.ball.speedX * Game.ball.speedX + Game.ball.speedY * Game.ball.speedY) + speedIncrease;
        Game.ball.speedX = Math.sin(angle) * currentSpeed;
        Game.ball.speedY = -Math.cos(angle) * currentSpeed;

        hapticFeedback('light');
        SFX.play('hit');
        createParticles(Game.ball.x, Game.ball.y, 'rgba(79, 209, 197, 1)', 12);

        if (Game.gameMode === 'chaotic') {
            Game.chaotic.hitCount++;
            Game.chaotic.speedBoost += 0.3;
            if (Game.chaotic.paddle1Width > 40) Game.chaotic.paddle1Width -= 2;
            if (Game.chaotic.paddle2Width > 40) Game.chaotic.paddle2Width -= 2;
            Game.chaotic.screenShake = 4 + Game.chaotic.hitCount * 0.3;
            Game.chaotic.bgPulse = 0.6;
            createParticles(Game.ball.x, Game.ball.y, 'rgba(255, 200, 50, 1)', 8);
        }
    }

    // --- Player 2/AI paddle (top) ---
    const prevBTop = prevBallY - Game.ball.radius;
    const currBTop = Game.ball.y - Game.ball.radius;
    const p2Bottom = Game.paddle2.y + Game.paddle2.height;
    const crossedP2 = prevBTop >= p2Bottom && currBTop <= p2Bottom;

    let p2CheckX = Game.ball.x;
    if (crossedP2 && currBTop !== prevBTop) {
        const t = (p2Bottom - prevBTop) / (currBTop - prevBTop);
        p2CheckX = prevBallX + effSX * t;
    }

    const p2Left = Game.paddle2.x - Game.ball.radius;
    const p2Right = Game.paddle2.x + Game.paddle2.width + Game.ball.radius;

    if ((crossedP2 || (currBTop < p2Bottom && currBTop > Game.paddle2.y)) &&
        p2CheckX > p2Left && p2CheckX < p2Right) {
        Game.ball.y = Game.paddle2.y + Game.paddle2.height + Game.ball.radius;

        const hitPos = Math.max(0, Math.min(1, (p2CheckX - Game.paddle2.x) / Game.paddle2.width));
        const maxAngle = Math.PI / 3;
        const spread2 = (Math.random() - 0.5) * 0.18; // Slight shotgun spread (~±5 degrees)
        const angle = (hitPos - 0.5) * maxAngle + spread2;

        Game.ball.hitCount++;
        Game.ball.accumulatedSpeedPct += hitSpeedPct * 100; // Track display %
        const speedIncrease2 = Game.ball.baseSpeed * hitSpeedPct;
        const currentSpeed = Math.sqrt(Game.ball.speedX * Game.ball.speedX + Game.ball.speedY * Game.ball.speedY) + speedIncrease2;
        Game.ball.speedX = Math.sin(angle) * currentSpeed;
        Game.ball.speedY = Math.cos(angle) * currentSpeed;

        hapticFeedback('light');
        SFX.play('hit');
        createParticles(Game.ball.x, Game.ball.y, 'rgba(16, 185, 129, 1)', 12);

        if (Game.gameMode === 'chaotic') {
            Game.chaotic.hitCount++;
            Game.chaotic.speedBoost += 0.3;
            if (Game.chaotic.paddle1Width > 40) Game.chaotic.paddle1Width -= 2;
            if (Game.chaotic.paddle2Width > 40) Game.chaotic.paddle2Width -= 2;
            Game.chaotic.screenShake = 4 + Game.chaotic.hitCount * 0.3;
            Game.chaotic.bgPulse = 0.6;

            createParticles(Game.ball.x, Game.ball.y, 'rgba(255, 200, 50, 1)', 8);
        }
    }

    // Cap ball speed
    const maxSpeed = Game.gameMode === 'chaotic' ? 25.9 : 20.1;
    const spd = Math.sqrt(Game.ball.speedX * Game.ball.speedX + Game.ball.speedY * Game.ball.speedY);
    if (spd > maxSpeed) {
        Game.ball.speedX = (Game.ball.speedX / spd) * maxSpeed;
        Game.ball.speedY = (Game.ball.speedY / spd) * maxSpeed;
    }

    // Score - Opponent missed (top) = Player 1 wins this round
    if (Game.roundActive && Game.ball.y - Game.ball.radius < 0) {
        SFX.play('score');
        if (Game.isAIGame) handleRoundResult('player1');
        else reportScoreToServer('player1');
    }

    // Score - Player missed (bottom) = Player 2/AI wins this round
    if (Game.roundActive && Game.ball.y + Game.ball.radius > Game.canvas.height) {
        SFX.play('scoreLost');
        if (Game.isAIGame) handleRoundResult('player2');
        else reportScoreToServer('player2');
    }
}

// Handle the result of a round (player1 wins, player2 wins, or tie)
function handleRoundResult(result) {
    // Guard against being called multiple times
    if (!Game.roundActive) return;
    Game.roundActive = false;
    hapticFeedback('medium');

    // Stop round timer
    if (Game.roundTimerInterval) {
        clearInterval(Game.roundTimerInterval);
        Game.roundTimerInterval = null;
    }

    // Award round win
    if (result === 'player1') {
        Game.roundWins.player1++;
        Game.score.player1 = Game.roundWins.player1;
        document.getElementById('player1Score').textContent = Game.score.player1;
    } else if (result === 'player2') {
        Game.roundWins.player2++;
        Game.score.player2 = Game.roundWins.player2;
        document.getElementById('player2Score').textContent = Game.score.player2;
    }
    // tie = no round wins awarded

    // Show round result from THIS player's perspective
    const iScored = (result === 'player1' && Game.isPlayer1) ||
                    (result === 'player2' && !Game.isPlayer1);
    const resultText = result === 'tie' ? 'Time up - Tie!' :
                       iScored ? 'You scored!' : 'Opponent scored!';
    document.getElementById('gameStatus').textContent = resultText;

    // Check if game is over after 3 rounds OR someone has 2 round wins (clinched)
    if (Game.currentRound >= 3 || Game.roundWins.player1 >= 2 || Game.roundWins.player2 >= 2) {
        setTimeout(() => {
            if (Game.isAIGame) {
                endAIGame();
            } else {
                endMultiplayerGame();
            }
        }, 1500);
    } else {
        // Next round with countdown
        Game.currentRound++;
        document.getElementById('currentRound').textContent = Game.currentRound;

        setTimeout(() => {
            showRoundCountdown();
        }, 1500);
    }
}

// Show 3-2-1-GO countdown between rounds (reuses race overlay)
function showRoundCountdown() {
    const overlay = document.getElementById('raceOverlay');
    const numEl = document.getElementById('raceNumber');
    const labelEl = document.getElementById('raceLabel');

    if (!overlay || !numEl) { startRound(); return; }

    overlay.classList.add('active');
    if (labelEl) labelEl.textContent = 'NEXT ROUND';

    let countdown = 3;
    numEl.textContent = countdown;
    numEl.className = 'race-number';
    numEl.style.animation = 'none';
    numEl.offsetHeight;
    numEl.style.animation = '';

    const countdownInterval = setInterval(() => {
        countdown--;

        if (countdown > 0) {
            numEl.textContent = countdown;
            numEl.className = 'race-number';
            numEl.style.animation = 'none';
            numEl.offsetHeight;
            numEl.style.animation = '';
            hapticFeedback('light');
            SFX.play('countdown');
        } else if (countdown === 0) {
            numEl.textContent = 'GO!';
            numEl.className = 'race-number go';
            numEl.style.animation = 'none';
            numEl.offsetHeight;
            numEl.style.animation = '';
            hapticFeedback('medium');
            SFX.play('go');
        } else {
            clearInterval(countdownInterval);
            overlay.classList.remove('active');
            numEl.className = 'race-number';
            startRound();
        }
    }, 1000);
}

// End multiplayer game — shows result from this client's perspective
function endMultiplayerGame() {
    if (!Game.isActive && !Game.roundActive) return;
    Game.isActive = false;
    Game.roundActive = false;

    if (Game.gameTimerInterval) clearInterval(Game.gameTimerInterval);
    if (Game.roundTimerInterval) { clearInterval(Game.roundTimerInterval); Game.roundTimerInterval = null; }

    hapticFeedback('heavy');

    // Determine winner from THIS player's perspective
    const myWins  = Game.isPlayer1 ? Game.roundWins.player1 : Game.roundWins.player2;
    const oppWins = Game.isPlayer1 ? Game.roundWins.player2 : Game.roundWins.player1;
    const isTie   = myWins === oppWins;
    const iWon    = myWins > oppWins;

    // Persist result to DB
    if (typeof finishDBMatch === 'function') finishDBMatch(iWon);

    const resultTitle = document.getElementById('resultTitle');
    const amountWon   = document.getElementById('amountWon');
    const finalScore  = document.getElementById('finalScore');
    const newBalance  = document.getElementById('newBalance');
    const fairEl      = document.getElementById('fairnessResult');
    if (fairEl) fairEl.style.display = 'none'; // reset until server sends reveal

    if (isTie) {
        resultTitle.textContent = 'Draw!';
        resultTitle.className = '';
        amountWon.textContent = 'Bets Returned';
        hapticFeedback('medium');
    } else if (iWon) {
        resultTitle.textContent = 'You Won!';
        resultTitle.className = 'win';
        const prize = (AppState.currentGame && AppState.currentGame.betAmount)
            ? (AppState.currentGame.betAmount * 2).toFixed(2) : '--';
        amountWon.textContent = '+$' + prize;
        hapticFeedback('success');
        SFX.play('win');
    } else {
        resultTitle.textContent = 'You Lost';
        resultTitle.className = 'lose';
        amountWon.textContent = '-$' + ((AppState.currentGame && AppState.currentGame.betAmount)
            ? AppState.currentGame.betAmount.toFixed(2) : '--');
        hapticFeedback('error');
        SFX.play('lose');
    }

    // Show "my rounds - opp rounds" score
    finalScore.textContent = myWins + '-' + oppWins + (isTie ? ' (Draw)' : '');
    if (typeof window.setResultMatchId === 'function') window.setResultMatchId(Game.gameId || '');
    newBalance.textContent = AppState.user.balance.toFixed(2);

    // Hide rematch button for multiplayer (no rematch flow yet)
    const rematchSection = document.getElementById('rematchSection');
    if (rematchSection) rematchSection.style.display = 'none';

    const reportBtn = document.getElementById('reportMatchBtn');
    if (reportBtn) reportBtn.style.display = 'block';

    // Show emoji section and reset state
    const emojiSection = document.getElementById('emojiSection');
    if (emojiSection) {
        emojiSection.style.display = 'block';
        document.querySelectorAll('.emoji-btn').forEach(b => { b.disabled = false; b.style.opacity = '1'; });
        const recv = document.getElementById('emojiReceived');
        if (recv) recv.style.display = 'none';
    }

    // Make opponent name tappable on result title area
    const opponentName = Game.isPlayer1
        ? (AppState.currentGame && AppState.currentGame.player2Name)
        : (AppState.currentGame && AppState.currentGame.player1Name);
    if (opponentName) {
        resultTitle.style.cursor = 'default';
        const opEl = document.getElementById('resultOpponent');
        if (opEl) {
            opEl.style.display = 'block';
            opEl.innerHTML = `vs <span style="color:#4fd1c5;cursor:pointer;text-decoration:underline;" onclick="openProfile('${opponentName}')">${opponentName}</span>`;
        }
    }

    setTimeout(() => { showScreen('resultScreen'); }, 1000);
}

// End AI game
function endAIGame() {
    // Guard against being called multiple times
    if (!Game.isActive && !Game.roundActive) return;
    Game.isActive = false;
    Game.roundActive = false;

    // Stop all timers
    if (Game.gameTimerInterval) {
        clearInterval(Game.gameTimerInterval);
    }
    if (Game.roundTimerInterval) {
        clearInterval(Game.roundTimerInterval);
        Game.roundTimerInterval = null;
    }

    hapticFeedback('heavy');

    const isTie = Game.roundWins.player1 === Game.roundWins.player2;
    const isWinner = Game.roundWins.player1 > Game.roundWins.player2;

    // Show result screen
    const resultTitle = document.getElementById('resultTitle');
    const amountWon = document.getElementById('amountWon');
    const finalScore = document.getElementById('finalScore');
    const newBalance = document.getElementById('newBalance');

    if (isTie) {
        resultTitle.textContent = 'Draw!';
        resultTitle.classList.remove('win');
        resultTitle.classList.remove('lose');
        amountWon.textContent = 'Bets Returned';
        hapticFeedback('medium');
    } else if (isWinner) {
        resultTitle.textContent = 'You Won!';
        resultTitle.classList.add('win');
        resultTitle.classList.remove('lose');
        amountWon.textContent = 'Practice Game';
        hapticFeedback('success');
        SFX.play('win');
        recordWin(0, 0);
    } else {
        resultTitle.textContent = 'AI Won';
        resultTitle.classList.add('lose');
        resultTitle.classList.remove('win');
        amountWon.textContent = 'Practice Game';
        hapticFeedback('error');
        SFX.play('lose');
        recordLoss(0);
    }

    finalScore.textContent = Game.roundWins.player1 + '-' + Game.roundWins.player2 +
        (isTie ? ' (Draw)' : '');
    if (typeof window.setResultMatchId === 'function') window.setResultMatchId(Game.gameId || '');
    newBalance.textContent = AppState.user.balance.toFixed(2);

    // Show rematch button for AI games
    const rematchSection = document.getElementById('rematchSection');
    rematchSection.style.display = 'block';
    const rematchBtn = document.getElementById('rematchBtn');
    rematchBtn.disabled = false;

    // Rematch countdown
    let rematchTime = 10;
    document.getElementById('rematchCountdown').textContent = rematchTime;
    const rematchInterval = setInterval(() => {
        rematchTime--;
        document.getElementById('rematchCountdown').textContent = rematchTime;
        if (rematchTime <= 0) {
            clearInterval(rematchInterval);
            rematchSection.style.display = 'none';
        }
    }, 1000);

    if (!rematchBtn.hasAttribute('data-init')) {
        rematchBtn.addEventListener('click', () => {
            clearInterval(rematchInterval);
            // Restart AI game with same mode
            showScreen('gameScreen');
            const aiGameData = {
                id: 'ai_' + Date.now(),
                player1Id: AppState.user.id,
                player1Name: AppState.user.name,
                player2Name: 'AI Bot',
                isAIGame: true,
                gameMode: Game.gameMode
            };
            initGame(aiGameData);
            startGame(aiGameData);
            hapticFeedback('medium');
        });
        rematchBtn.setAttribute('data-init', 'true');
    }

    document.getElementById('reportMatchBtn').style.display = 'none';

    setTimeout(() => {
        showScreen('resultScreen');
    }, 1000);
}

// Resize canvas to fit screen
function resizeCanvas() {
    Game.canvas.width = window.innerWidth;
    Game.canvas.height = window.innerHeight - 120; // Account for UI bars
}

// Reset ball and paddle positions
function resetBallAndPaddles() {
    Game.ball.x = Game.canvas.width / 2;
    Game.ball.y = Game.canvas.height / 2;
    Game.ball.speedX = 0;
    Game.ball.speedY = 0;
    Game.ball.trail = []; // Clear trail to avoid cross-round visual glitch

    // Reset paddle widths to default (in case shrink boost was active)
    Game.paddle1.width = 96;
    Game.paddle2.width = 96;

    // Player 1 paddle (bottom - player's paddle)
    Game.paddle1.x = Game.canvas.width / 2 - Game.paddle1.width / 2;
    Game.paddle1.y = Game.canvas.height - 30 - Game.paddle1.height;

    // Player 2 paddle (top - opponent's paddle)
    Game.paddle2.x = Game.canvas.width / 2 - Game.paddle2.width / 2;
    Game.paddle2.y = 30;
}

// Setup touch and mouse controls (only once per canvas)
let controlsInitialized = false;
function setupTouchControls() {
    if (controlsInitialized) return;
    controlsInitialized = true;

    // Touch controls
    Game.canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    Game.canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    Game.canvas.addEventListener('touchend', handleTouchEnd, { passive: false });

    // Mouse controls (for PC)
    Game.canvas.addEventListener('mouseenter', handleMouseEnter);
    Game.canvas.addEventListener('mousemove', handleMouseMove);
    Game.canvas.addEventListener('mouseleave', handleMouseLeave);
}

// Handle touch start
function handleTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    Game.touchX = touch.clientX;
    Game.isTouching = true;
}

// Handle touch move
function handleTouchMove(e) {
    e.preventDefault();

    if (!Game.isTouching || !Game.roundActive) return;

    const touch = e.touches[0];
    Game.touchX = touch.clientX;

    // Update our paddle position
    const paddle = Game.isPlayer1 ? Game.paddle1 : Game.paddle2;

    // Center paddle on touch position
    let newX = Game.touchX - paddle.width / 2;

    // Keep paddle within bounds
    if (newX < 0) newX = 0;
    if (newX > Game.canvas.width - paddle.width) {
        newX = Game.canvas.width - paddle.width;
    }

    paddle.x = newX;

    // Send paddle position to server
    sendPaddlePosition(paddle.x);
}

// Handle touch end
function handleTouchEnd(e) {
    e.preventDefault();
    Game.isTouching = false;
}

// Handle mouse enter (PC controls)
function handleMouseEnter(e) {
    Game.isMouseControl = true;
}

// Handle mouse move (PC controls)
function handleMouseMove(e) {
    if (!Game.isMouseControl || !Game.roundActive) return;

    const rect = Game.canvas.getBoundingClientRect();
    Game.mouseX = e.clientX - rect.left;

    // Update our paddle position
    const paddle = Game.isPlayer1 ? Game.paddle1 : Game.paddle2;

    // Center paddle on mouse position
    let newX = Game.mouseX - paddle.width / 2;

    // Keep paddle within bounds
    if (newX < 0) newX = 0;
    if (newX > Game.canvas.width - paddle.width) {
        newX = Game.canvas.width - paddle.width;
    }

    paddle.x = newX;

    // Send paddle position to server
    if (!Game.isAIGame) {
        sendPaddlePosition(paddle.x);
    }
}

// Handle mouse leave (PC controls)
function handleMouseLeave(e) {
    Game.isMouseControl = false;
}

// Send paddle position to server as a normalized 0-1 fraction of canvas width
// This makes it device-independent — server maps to virtual world coords
let _lastPaddleSendTime = 0;
function sendPaddlePosition(x) {
    if (Game.isAIGame) return;
    const now = performance.now();
    if (now - _lastPaddleSendTime < 16) return; // cap at ~60fps to avoid flooding
    _lastPaddleSendTime = now;
    const myWidth = (Game.isPlayer1 ? Game.paddle1 : Game.paddle2).width;
    const fraction = Math.max(0, Math.min(1, x / (Game.canvas.width - myWidth)));
    sendToServer({ type: 'paddleMove', gameId: Game.gameId, xFraction: fraction });
}

// Update game state from server
function updateGame(data) {
    // Update opponent paddle position
    if (data.paddleX !== undefined) {
        const opponentPaddle = Game.isPlayer1 ? Game.paddle2 : Game.paddle1;
        opponentPaddle.x = data.paddleX;
    }

    // Update ball position (server is authoritative)
    if (data.ball) {
        Game.ball.x = data.ball.x;
        Game.ball.y = data.ball.y;
        Game.ball.speedX = data.ball.speedX;
        Game.ball.speedY = data.ball.speedY;
    }

    // Update scores
    if (data.score) {
        Game.score.player1 = data.score.player1;
        Game.score.player2 = data.score.player2;

        document.getElementById('player1Score').textContent = data.score.player1;
        document.getElementById('player2Score').textContent = data.score.player2;
    }

    // Round ended
    if (data.roundEnd) {
        handleRoundEnd(data);
    }
}

// Handle round end
function handleRoundEnd(data) {
    Game.roundActive = false;
    if (Game.roundTimerInterval) {
        clearInterval(Game.roundTimerInterval);
        Game.roundTimerInterval = null;
    }
    hapticFeedback('medium');

    const winner = data.roundWinner;

    if (winner === 1) {
        document.getElementById('gameStatus').textContent = 'Player 1 scores!';
    } else {
        document.getElementById('gameStatus').textContent = 'Player 2 scores!';
    }

    // Check if game is over
    if (Game.score.player1 === 2 || Game.score.player2 === 2) {
        // Best of 3 - someone won 2 rounds
        setTimeout(() => {
            // Game will end, wait for server
        }, 2000);
    } else {
        // Start next round
        Game.currentRound++;
        document.getElementById('currentRound').textContent = Game.currentRound;

        setTimeout(() => {
            startRound();
        }, 2000);
    }
}

// End game
function endGame(data) {
    console.log('Game ended:', data);

    Game.isActive = false;
    Game.roundActive = false;

    // Stop game timer
    if (Game.gameTimerInterval) {
        clearInterval(Game.gameTimerInterval);
    }

    hapticFeedback('heavy');

    // Show result screen
    const isWinner = data.winnerId === AppState.user.id;
    const resultTitle = document.getElementById('resultTitle');
    const amountWon = document.getElementById('amountWon');
    const finalScore = document.getElementById('finalScore');
    const newBalance = document.getElementById('newBalance');

    if (isWinner) {
        resultTitle.textContent = 'You Won!';
        resultTitle.classList.add('win');
        resultTitle.classList.remove('lose');

        amountWon.textContent = '+' + data.winAmount.toFixed(2);
        amountWon.classList.add('amount-won');
        amountWon.classList.remove('amount-lost');

        hapticFeedback('success');
    } else {
        resultTitle.textContent = 'You Lost';
        resultTitle.classList.add('lose');
        resultTitle.classList.remove('win');

        amountWon.textContent = '-' + data.betAmount.toFixed(2);
        amountWon.classList.add('amount-lost');
        amountWon.classList.remove('amount-won');

        hapticFeedback('error');
    }

    finalScore.textContent = Game.score.player1 + '-' + Game.score.player2;
    newBalance.textContent = data.newBalance.toFixed(2);

    // Update app balance
    updateBalance(data.newBalance);

    // Show result screen
    setTimeout(() => {
        showScreen('resultScreen');
    }, 1000);
}

// Draw speed meter and round timer HUD
function drawGameHUD() {
    if (!Game.roundActive) return;
    const ctx = Game.ctx;
    const w = Game.canvas.width;
    const h = Game.canvas.height;
    const now = Date.now();

    // Speed percentage: uses accumulated value (accounts for dynamic rate changes)
    const speedPct = Game.ball.accumulatedSpeedPct || 0;

    // Update the gameTimer HTML element with round time
    const timerEl = document.getElementById('gameTimer');
    if (timerEl && Game.roundTimeRemaining !== undefined) {
        timerEl.textContent = Math.ceil(Game.roundTimeRemaining) + 's';
    }

    // === Speed percentage number (both modes) - color shifts as speed ramps up ===
    const pctVal = Math.round(speedPct);

    // Color progression: teal(0%) -> yellow(40%) -> orange(80%) -> red(120%) -> purple(160%+)
    let sr, sg, sb;
    if (speedPct < 40) {
        const t = speedPct / 40;
        sr = Math.round(79 + t * 176); sg = Math.round(209 - t * 9); sb = Math.round(197 - t * 147);
    } else if (speedPct < 80) {
        const t = (speedPct - 40) / 40;
        sr = 255; sg = Math.round(200 - t * 120); sb = Math.round(50 - t * 20);
    } else if (speedPct < 120) {
        const t = (speedPct - 80) / 40;
        sr = 255; sg = Math.round(80 - t * 60); sb = Math.round(30 + t * 10);
    } else {
        const t = Math.min(1, (speedPct - 120) / 60);
        sr = Math.round(255 - t * 55); sg = Math.round(20 + t * 30); sb = Math.round(40 + t * 200);
    }

    const speedAlpha = pctVal > 0 ? 0.7 + Math.min(0.3, speedPct / 200) : 0.3;
    ctx.font = pctVal >= 100 ? 'bold 14px monospace' : 'bold 12px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = `rgba(${sr}, ${sg}, ${sb}, ${speedAlpha})`;

    // Glow at high speed
    if (pctVal >= 100) {
        ctx.shadowColor = `rgb(${sr}, ${sg}, ${sb})`;
        ctx.shadowBlur = 6 + Math.sin(now / 100) * 3;
    }
    ctx.fillText(pctVal + '%', w - 10, h * 0.5);
    ctx.shadowBlur = 0;

    // --- Round Timer on canvas (top-center) ---
    if (Game.roundTimeRemaining !== undefined && Game.roundTimeRemaining > 0) {
        const secs = Math.ceil(Game.roundTimeRemaining);
        const urgency = secs <= 10;
        ctx.font = urgency ? 'bold 14px monospace' : '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = urgency ? `rgba(255, 100, 100, ${0.6 + Math.sin(now / 150) * 0.3})` : 'rgba(255, 255, 255, 0.3)';
        ctx.fillText(secs + 's', w / 2, 18);
    }
}

// Game loop
let _loopTickCount = 0;
function gameLoop() {
    if (!Game.isActive) return;

    // Log first few ticks so we can confirm loop is running in multiplayer
    if (_loopTickCount < 3) {
        _loopTickCount++;
        console.log('[LOOP] tick #' + _loopTickCount + ' roundActive=' + Game.roundActive +
            ' isAI=' + Game.isAIGame + ' ballVx=' + Game.ball.speedX.toFixed(2));
    }

    const ctx = Game.ctx;
    const H = Game.canvas.height;

    // ── Physics (always in world coordinates, no transform needed) ──
    try {
        if (Game.isAIGame) updateAIPaddle();
        updateBallPhysics(); // runs for BOTH AI and multiplayer (guarded by roundActive)
        updateParticles();

        // Multiplayer: extrapolate ball between server frames + lerp opponent paddle
        if (!Game.isAIGame && Game.roundActive) {
            if (Game.ball._svT !== undefined) {
                const dt = (performance.now() - Game.ball._svT) * 60 / 1000; // frames elapsed
                Game.ball.x = Game.ball._svX + Game.ball.speedX * Game.ball._ramp * dt;
                Game.ball.y = Game.ball._svY + Game.ball.speedY * Game.ball._ramp * dt;
            }
            const opp = Game.isPlayer1 ? Game.paddle2 : Game.paddle1;
            if (opp._targetX !== undefined) {
                opp.x += (opp._targetX - opp.x) * 0.3;
            }
        }
    } catch (e) {
        console.error('[LOOP] physics error:', e);
    }

    // ── Rendering: flip canvas vertically for player2 ──
    // Player2 controls paddle2 (world-top). Flipping makes it appear at visual-bottom.
    ctx.save();
    if (!Game.isPlayer1) {
        // 180° vertical flip around canvas center
        ctx.translate(0, H);
        ctx.scale(1, -1);
    }

    try {
        drawBackground();
        drawCustomPaddle(Game.paddle1, '#4fd1c5', Game.paddleSkin);
        drawCustomPaddle(Game.paddle2, '#10b981', 'default');
        drawChaoticVisuals();
        drawParticles();
        drawBall();
    } catch (e) {
        console.error('[LOOP] draw error:', e);
    }

    ctx.restore(); // back to normal (un-flipped) coords

    // ── HUD text always drawn in screen coords (never upside-down) ──
    try {
        drawGameHUD();
    } catch (e) {
        console.error('[LOOP] HUD error:', e);
    }

    // Continue loop
    Game.animFrameId = requestAnimationFrame(gameLoop);
}

// Initialize background particles
function initBackground() {
    Game.bgParticles = [];
    for (let i = 0; i < 40; i++) {
        Game.bgParticles.push({
            x: Math.random() * (Game.canvas.width || 400),
            y: Math.random() * (Game.canvas.height || 600),
            size: 0.5 + Math.random() * 2,
            speedX: (Math.random() - 0.5) * 0.3,
            speedY: (Math.random() - 0.5) * 0.3,
            alpha: 0.1 + Math.random() * 0.3
        });
    }
    Game.bgInitialized = true;
}

// Draw animated background
function drawBackground() {
    const w = Game.canvas.width;
    const h = Game.canvas.height;
    const now = Date.now();

    // Dark gradient background (brightened)
    const bgGrad = Game.ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#131a24');
    bgGrad.addColorStop(0.5, '#1a2535');
    bgGrad.addColorStop(1, '#131a24');
    Game.ctx.fillStyle = bgGrad;
    Game.ctx.fillRect(0, 0, w, h);

    // Grid pattern (more visible)
    Game.ctx.strokeStyle = 'rgba(79, 209, 197, 0.08)';
    Game.ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < w; x += gridSize) {
        Game.ctx.beginPath();
        Game.ctx.moveTo(x, 0);
        Game.ctx.lineTo(x, h);
        Game.ctx.stroke();
    }
    for (let y = 0; y < h; y += gridSize) {
        Game.ctx.beginPath();
        Game.ctx.moveTo(0, y);
        Game.ctx.lineTo(w, y);
        Game.ctx.stroke();
    }

    // Initialize particles if needed
    if (!Game.bgInitialized) initBackground();

    // Floating ambient particles
    for (const p of Game.bgParticles) {
        p.x += p.speedX;
        p.y += p.speedY;

        // Wrap around
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;

        const twinkle = Math.sin(now / 1000 + p.x) * 0.15;
        Game.ctx.fillStyle = `rgba(79, 209, 197, ${p.alpha + twinkle})`;
        Game.ctx.beginPath();
        Game.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        Game.ctx.fill();
    }

    // Center line (dashed, subtle glow)
    Game.ctx.strokeStyle = 'rgba(79, 209, 197, 0.25)';
    Game.ctx.lineWidth = 1;
    Game.ctx.setLineDash([8, 8]);
    Game.ctx.beginPath();
    Game.ctx.moveTo(0, h / 2);
    Game.ctx.lineTo(w, h / 2);
    Game.ctx.stroke();
    Game.ctx.setLineDash([]);

    // Side accent lines
    Game.ctx.strokeStyle = 'rgba(79, 209, 197, 0.15)';
    Game.ctx.lineWidth = 2;
    Game.ctx.beginPath();
    Game.ctx.moveTo(0, 0);
    Game.ctx.lineTo(0, h);
    Game.ctx.stroke();
    Game.ctx.beginPath();
    Game.ctx.moveTo(w, 0);
    Game.ctx.lineTo(w, h);
    Game.ctx.stroke();
}

// Helper: draw rounded capsule paddle shape
function drawCapsule(ctx, x, y, w, h, color) {
    const r = h / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
    ctx.fill();
}

function strokeCapsule(ctx, x, y, w, h) {
    const r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
    ctx.stroke();
}

// Draw paddle with customization
function drawCustomPaddle(paddle, defaultColor, skin) {
    const now = Date.now();

    Game.ctx.save();

    switch (skin) {
        case 'frost': {
            // FROST PADDLE ($10) - Icy blue with crystal mist
            // Icy gradient capsule
            const frostGrad = Game.ctx.createLinearGradient(paddle.x, paddle.y, paddle.x + paddle.width, paddle.y);
            frostGrad.addColorStop(0, '#a5d8ff');
            frostGrad.addColorStop(0.3, '#e7f5ff');
            frostGrad.addColorStop(0.5, '#ffffff');
            frostGrad.addColorStop(0.7, '#e7f5ff');
            frostGrad.addColorStop(1, '#a5d8ff');

            Game.ctx.shadowColor = '#74c0fc';
            Game.ctx.shadowBlur = 20;
            drawCapsule(Game.ctx, paddle.x, paddle.y, paddle.width, paddle.height, 'transparent');
            Game.ctx.fillStyle = frostGrad;
            Game.ctx.fill();

            // Ice crystal edges
            Game.ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
            Game.ctx.lineWidth = 1.5;
            strokeCapsule(Game.ctx, paddle.x, paddle.y, paddle.width, paddle.height);

            // Frost crystals extending from edges
            for (let i = 0; i < 6; i++) {
                const cx = paddle.x + (i / 5) * paddle.width;
                const crystalH = 3 + Math.sin(now / 200 + i) * 2;
                Game.ctx.strokeStyle = `rgba(165, 216, 255, ${0.5 + Math.sin(now / 150 + i) * 0.3})`;
                Game.ctx.lineWidth = 1;

                // Top crystals
                Game.ctx.beginPath();
                Game.ctx.moveTo(cx, paddle.y);
                Game.ctx.lineTo(cx - 1, paddle.y - crystalH);
                Game.ctx.lineTo(cx + 1, paddle.y - crystalH);
                Game.ctx.stroke();

                // Bottom crystals
                Game.ctx.beginPath();
                Game.ctx.moveTo(cx, paddle.y + paddle.height);
                Game.ctx.lineTo(cx - 1, paddle.y + paddle.height + crystalH);
                Game.ctx.lineTo(cx + 1, paddle.y + paddle.height + crystalH);
                Game.ctx.stroke();
            }

            // Cold mist particles
            if (Math.random() < 0.2) {
                Game.skinParticles.push({
                    x: paddle.x + Math.random() * paddle.width,
                    y: paddle.y + Math.random() * paddle.height,
                    vx: (Math.random() - 0.5) * 1,
                    vy: -0.5 - Math.random(),
                    life: 30,
                    maxLife: 30,
                    size: 2 + Math.random() * 3,
                    color: 'frost'
                });
            }

            Game.ctx.shadowBlur = 0;
            break;
        }
        case 'void': {
            // VOID PADDLE ($50 PREMIUM) - Dark matter with gravitational distortion
            // Dark core capsule
            Game.ctx.shadowColor = '#7c3aed';
            Game.ctx.shadowBlur = 30;
            drawCapsule(Game.ctx, paddle.x, paddle.y, paddle.width, paddle.height, '#0a0015');

            // Purple-to-black inner gradient
            const voidGrad = Game.ctx.createRadialGradient(
                paddle.x + paddle.width / 2, paddle.y + paddle.height / 2, 0,
                paddle.x + paddle.width / 2, paddle.y + paddle.height / 2, paddle.width / 2
            );
            voidGrad.addColorStop(0, 'rgba(15, 0, 30, 1)');
            voidGrad.addColorStop(0.6, 'rgba(60, 0, 120, 0.6)');
            voidGrad.addColorStop(1, 'rgba(124, 58, 237, 0.3)');
            drawCapsule(Game.ctx, paddle.x, paddle.y, paddle.width, paddle.height, 'transparent');
            Game.ctx.fillStyle = voidGrad;
            Game.ctx.fill();

            // Gravitational light-bending rings
            for (let ring = 0; ring < 3; ring++) {
                const ringOffset = Math.sin(now / 300 + ring * 2) * 3;
                const ringAlpha = 0.3 - ring * 0.08;
                Game.ctx.strokeStyle = `rgba(124, 58, 237, ${ringAlpha})`;
                Game.ctx.lineWidth = 1;
                Game.ctx.shadowColor = '#7c3aed';
                Game.ctx.shadowBlur = 8;

                const r = paddle.height / 2 + 3 + ring * 3;
                Game.ctx.beginPath();
                Game.ctx.ellipse(
                    paddle.x + paddle.width / 2, paddle.y + paddle.height / 2 + ringOffset,
                    paddle.width / 2 + ring * 4, r,
                    0, 0, Math.PI * 2
                );
                Game.ctx.stroke();
            }

            // Energy wisps being pulled into the paddle
            if (Math.random() < 0.2) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 15 + Math.random() * 10;
                Game.skinParticles.push({
                    x: paddle.x + paddle.width / 2 + Math.cos(angle) * dist,
                    y: paddle.y + paddle.height / 2 + Math.sin(angle) * dist,
                    targetX: paddle.x + paddle.width / 2,
                    targetY: paddle.y + paddle.height / 2,
                    life: 20,
                    maxLife: 20,
                    size: 1 + Math.random() * 2,
                    color: 'void'
                });
            }

            // Edge glow
            Game.ctx.strokeStyle = 'rgba(167, 139, 250, 0.6)';
            Game.ctx.lineWidth = 2;
            Game.ctx.shadowColor = '#a78bfa';
            Game.ctx.shadowBlur = 15;
            strokeCapsule(Game.ctx, paddle.x, paddle.y, paddle.width, paddle.height);

            Game.ctx.shadowBlur = 0;
            break;
        }
        case 'sakura': {
            // SAKURA PADDLE ($100 wager) - Pink cherry blossom with falling petals
            // Soft pink capsule
            const sakuraGrad = Game.ctx.createLinearGradient(paddle.x, paddle.y, paddle.x + paddle.width, paddle.y);
            sakuraGrad.addColorStop(0, '#ffc0cb');
            sakuraGrad.addColorStop(0.3, '#ffb6c1');
            sakuraGrad.addColorStop(0.5, '#fff0f5');
            sakuraGrad.addColorStop(0.7, '#ffb6c1');
            sakuraGrad.addColorStop(1, '#ffc0cb');

            Game.ctx.shadowColor = '#ff69b4';
            Game.ctx.shadowBlur = 18;
            drawCapsule(Game.ctx, paddle.x, paddle.y, paddle.width, paddle.height, 'transparent');
            Game.ctx.fillStyle = sakuraGrad;
            Game.ctx.fill();

            // Soft white edge
            Game.ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
            Game.ctx.lineWidth = 1.5;
            strokeCapsule(Game.ctx, paddle.x, paddle.y, paddle.width, paddle.height);
            Game.ctx.shadowBlur = 0;

            // Falling cherry blossom petals (slow gentle drift)
            if (Math.random() < 0.1) {
                Game.skinParticles.push({
                    x: paddle.x + Math.random() * paddle.width,
                    y: paddle.y,
                    vx: (Math.random() - 0.5) * 0.4,
                    vy: 0.15 + Math.random() * 0.25,
                    life: 180,
                    maxLife: 180,
                    size: 3 + Math.random() * 2,
                    rotation: Math.random() * Math.PI * 2,
                    rotSpeed: (Math.random() - 0.5) * 0.03,
                    color: 'sakura'
                });
            }

            // Shimmer on paddle surface
            const shimmer = Math.sin(now / 150) * 0.15 + 0.15;
            Game.ctx.fillStyle = `rgba(255, 255, 255, ${shimmer})`;
            drawCapsule(Game.ctx, paddle.x + 5, paddle.y + 2, paddle.width - 10, paddle.height / 3, `rgba(255, 255, 255, ${shimmer})`);
            break;
        }
        case 'solar': {
            // SOLAR PADDLE ($500 wager) - Sun with corona flares
            // Blazing gold core capsule
            const solarGrad = Game.ctx.createRadialGradient(
                paddle.x + paddle.width / 2, paddle.y + paddle.height / 2, 0,
                paddle.x + paddle.width / 2, paddle.y + paddle.height / 2, paddle.width / 2
            );
            solarGrad.addColorStop(0, '#fff8e1');
            solarGrad.addColorStop(0.3, '#ffd54f');
            solarGrad.addColorStop(0.7, '#ff8f00');
            solarGrad.addColorStop(1, '#e65100');

            Game.ctx.shadowColor = '#ff9800';
            Game.ctx.shadowBlur = 35 + Math.sin(now / 100) * 8;
            drawCapsule(Game.ctx, paddle.x, paddle.y, paddle.width, paddle.height, 'transparent');
            Game.ctx.fillStyle = solarGrad;
            Game.ctx.fill();

            // Corona flares extending outward
            for (let i = 0; i < 8; i++) {
                const flareAngle = (i / 8) * Math.PI * 2 + now / 800;
                const flareLen = 6 + Math.sin(now / 150 + i * 1.5) * 4;
                const fx = paddle.x + paddle.width / 2 + Math.cos(flareAngle) * (paddle.width / 2.2);
                const fy = paddle.y + paddle.height / 2 + Math.sin(flareAngle) * (paddle.height / 1.5);

                Game.ctx.strokeStyle = `rgba(255, 183, 77, ${0.5 + Math.sin(now / 100 + i) * 0.3})`;
                Game.ctx.lineWidth = 2;
                Game.ctx.shadowColor = '#ffb74d';
                Game.ctx.shadowBlur = 6;

                Game.ctx.beginPath();
                Game.ctx.moveTo(fx, fy);
                Game.ctx.lineTo(
                    fx + Math.cos(flareAngle) * flareLen,
                    fy + Math.sin(flareAngle) * flareLen
                );
                Game.ctx.stroke();
            }

            // Solar wind particles
            if (Math.random() < 0.2) {
                const angle = Math.random() * Math.PI * 2;
                Game.skinParticles.push({
                    x: paddle.x + paddle.width / 2,
                    y: paddle.y + paddle.height / 2,
                    vx: Math.cos(angle) * (1 + Math.random() * 2),
                    vy: Math.sin(angle) * (1 + Math.random() * 2),
                    life: 25,
                    maxLife: 25,
                    size: 1 + Math.random() * 2,
                    color: 'solar'
                });
            }

            // White-hot core highlight
            Game.ctx.fillStyle = `rgba(255, 255, 255, ${0.3 + Math.sin(now / 120) * 0.15})`;
            drawCapsule(Game.ctx, paddle.x + paddle.width * 0.3, paddle.y + 3, paddle.width * 0.4, paddle.height / 3, `rgba(255, 255, 255, ${0.3 + Math.sin(now / 120) * 0.15})`);

            Game.ctx.shadowBlur = 0;
            break;
        }
        default: {
            // Basic paddle - pearl white capsule with subtle glow
            const pearlGrad = Game.ctx.createLinearGradient(paddle.x, paddle.y, paddle.x + paddle.width, paddle.y);
            pearlGrad.addColorStop(0, '#d4c5b0');
            pearlGrad.addColorStop(0.3, '#ede4d8');
            pearlGrad.addColorStop(0.5, '#f5efe8');
            pearlGrad.addColorStop(0.7, '#ede4d8');
            pearlGrad.addColorStop(1, '#d4c5b0');

            Game.ctx.shadowColor = '#e8ddd0';
            Game.ctx.shadowBlur = 12;
            drawCapsule(Game.ctx, paddle.x, paddle.y, paddle.width, paddle.height, 'transparent');
            Game.ctx.fillStyle = pearlGrad;
            Game.ctx.fill();

            // Subtle pearl highlight
            drawCapsule(Game.ctx, paddle.x + 5, paddle.y + 2, paddle.width - 10, paddle.height / 3, 'rgba(255, 255, 255, 0.2)');

            Game.ctx.shadowBlur = 0;
            break;
        }
    }

    // Draw skin particles (shared system for all skins)
    Game.skinParticles = Game.skinParticles.filter(p => {
        p.life--;
        if (p.life <= 0) return false;

        const alpha = p.life / p.maxLife;

        if (p.color === 'void') {
            // Void particles: pulled toward center
            const dx = p.targetX - p.x;
            const dy = p.targetY - p.y;
            p.x += dx * 0.08;
            p.y += dy * 0.08;
            Game.ctx.fillStyle = `rgba(167, 139, 250, ${alpha})`;
        } else if (p.color === 'frost') {
            p.x += p.vx;
            p.y += p.vy;
            Game.ctx.fillStyle = `rgba(165, 216, 255, ${alpha * 0.6})`;
        } else if (p.color === 'sakura') {
            p.x += p.vx + Math.sin(p.life * 0.1) * 0.3;
            p.y += p.vy;
            p.rotation += p.rotSpeed;
            // Draw petal shape
            Game.ctx.save();
            Game.ctx.translate(p.x, p.y);
            Game.ctx.rotate(p.rotation);
            Game.ctx.fillStyle = `rgba(255, 182, 193, ${alpha})`;
            Game.ctx.beginPath();
            Game.ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, Math.PI * 2);
            Game.ctx.fill();
            Game.ctx.restore();
            return true;
        } else if (p.color === 'solar') {
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= 0.95;
            p.vy *= 0.95;
            Game.ctx.fillStyle = `rgba(255, 183, 77, ${alpha})`;
        } else {
            p.x += p.vx || 0;
            p.y += p.vy || 0;
            Game.ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        }

        Game.ctx.beginPath();
        Game.ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
        Game.ctx.fill();
        return true;
    });

    Game.ctx.shadowBlur = 0;
    Game.ctx.restore();
}

// Draw ball with speed-based heat glow indicator
function drawBall() {
    // Draw trail
    drawBallTrail();

    // Calculate speed ratio for heat indicator
    const spd = Math.sqrt(Game.ball.speedX * Game.ball.speedX + Game.ball.speedY * Game.ball.speedY);
    const maxSpd = Game.gameMode === 'chaotic' ? 18 : 14;
    const heat = Math.min(1, spd / maxSpd);

    // Ball radius (oscillates in chaotic mode)
    let radius = Game.ball.radius;
    if (Game.gameMode === 'chaotic') {
        radius = Game.ball.radius + Math.sin(Game.chaotic.ballSizePhase) * 2;
        // Mega boost: ball grows 60% bigger
        if (Game.chaotic.activeBoost && Game.chaotic.activeBoost.type.id === 'mega') {
            radius *= 1.6;
        }
    }

    // Check if ghost boost is active
    const isGhost = Game.gameMode === 'chaotic' && Game.chaotic.activeBoost && Game.chaotic.activeBoost.type.id === 'ghost';
    const ghostAlpha = isGhost ? 0.3 + Math.sin(Date.now() * 0.008) * 0.15 : 1;

    // Heat color: white -> yellow -> orange -> red
    let r = 255;
    let g = Math.round(255 - heat * 180);
    let b = Math.round(255 - heat * 230);

    if (isGhost) {
        // Ghost ball: eerie cyan tint
        r = 100; g = 220; b = 255;
    }

    const ballColor = isGhost
        ? `rgba(${r}, ${g}, ${b}, ${ghostAlpha})`
        : `rgb(${r}, ${g}, ${b})`;

    // Outer glow color matches heat (or ghostly cyan)
    const glowColor = isGhost ? `rgba(100, 220, 255, ${ghostAlpha})` :
                      heat < 0.3 ? '#ffffff' :
                      heat < 0.6 ? '#ffcc44' :
                      heat < 0.8 ? '#ff8800' : '#ff3300';

    // Draw ball
    if (isGhost) {
        Game.ctx.globalAlpha = ghostAlpha;
    }
    Game.ctx.shadowColor = glowColor;
    Game.ctx.shadowBlur = isGhost ? 25 : 15 + heat * 20;
    Game.ctx.fillStyle = ballColor;
    Game.ctx.beginPath();
    Game.ctx.arc(Game.ball.x, Game.ball.y, radius, 0, Math.PI * 2);
    Game.ctx.fill();

    // Inner bright core
    Game.ctx.fillStyle = isGhost
        ? `rgba(180, 240, 255, ${ghostAlpha * 0.5})`
        : `rgba(255, 255, 255, ${0.6 + heat * 0.2})`;
    Game.ctx.beginPath();
    Game.ctx.arc(Game.ball.x, Game.ball.y, radius * 0.4, 0, Math.PI * 2);
    Game.ctx.fill();
    Game.ctx.shadowBlur = 0;
    if (isGhost) {
        Game.ctx.globalAlpha = 1;
    }
}

// Draw ball trail effect
function drawBallTrail() {
    // Add current position to trail
    Game.ball.trail.push({ x: Game.ball.x, y: Game.ball.y });

    // Limit trail length
    if (Game.ball.trail.length > 10) {
        Game.ball.trail.shift();
    }

    // Ghost boost: reduced, cyan-tinted trail
    const isGhost = Game.gameMode === 'chaotic' && Game.chaotic.activeBoost && Game.chaotic.activeBoost.type.id === 'ghost';

    // Draw trail
    for (let i = 0; i < Game.ball.trail.length; i++) {
        const alpha = (i / Game.ball.trail.length) * (isGhost ? 0.15 : 0.5);
        const radius = Game.ball.radius * (i / Game.ball.trail.length);

        Game.ctx.fillStyle = isGhost
            ? `rgba(100, 220, 255, ${alpha})`
            : `rgba(255, 255, 255, ${alpha})`;
        Game.ctx.beginPath();
        Game.ctx.arc(Game.ball.trail[i].x, Game.ball.trail[i].y, radius, 0, Math.PI * 2);
        Game.ctx.fill();
    }
}

// Particle system
function createParticles(x, y, color, count = 15) {
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 3 + 1;

        Game.particles.push({
            x: x,
            y: y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 1.0,
            color: color,
            size: Math.random() * 3 + 1
        });
    }
}

function updateParticles() {
    for (let i = Game.particles.length - 1; i >= 0; i--) {
        const p = Game.particles[i];

        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.02;
        p.size *= 0.98;

        if (p.life <= 0) {
            Game.particles.splice(i, 1);
        }
    }
}

function drawParticles() {
    for (const p of Game.particles) {
        Game.ctx.fillStyle = p.color.replace('1)', `${p.life})`).replace('rgb', 'rgba');
        Game.ctx.beginPath();
        Game.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        Game.ctx.fill();
    }
}

// Sound Effects System (Web Audio API - subtle)
const SFX = {
    ctx: null,
    enabled: true,
    volume: 0.15, // Subtle volume

    init() {
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            this.enabled = false;
        }
    },

    play(type) {
        if (!this.enabled || !this.ctx) return;
        // Resume context if suspended (browser autoplay policy)
        if (this.ctx.state === 'suspended') this.ctx.resume();

        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        switch (type) {
            case 'hit':
                // Short soft tick
                osc.type = 'sine';
                osc.frequency.setValueAtTime(600, now);
                osc.frequency.exponentialRampToValueAtTime(300, now + 0.08);
                gain.gain.setValueAtTime(this.volume, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
                osc.start(now);
                osc.stop(now + 0.1);
                break;

            case 'score':
                // Rising tone
                osc.type = 'sine';
                osc.frequency.setValueAtTime(400, now);
                osc.frequency.exponentialRampToValueAtTime(800, now + 0.15);
                gain.gain.setValueAtTime(this.volume * 0.8, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
                osc.start(now);
                osc.stop(now + 0.2);
                break;

            case 'scoreLost':
                // Falling tone
                osc.type = 'sine';
                osc.frequency.setValueAtTime(500, now);
                osc.frequency.exponentialRampToValueAtTime(200, now + 0.2);
                gain.gain.setValueAtTime(this.volume * 0.7, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
                osc.start(now);
                osc.stop(now + 0.25);
                break;

            case 'countdown':
                // Short metallic tick for race countdown
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(800, now);
                osc.frequency.exponentialRampToValueAtTime(400, now + 0.06);
                gain.gain.setValueAtTime(this.volume * 0.6, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
                osc.start(now);
                osc.stop(now + 0.1);
                break;

            case 'go':
                // Bright ascending chord burst
                osc.type = 'sine';
                osc.frequency.setValueAtTime(523, now);
                osc.frequency.setValueAtTime(784, now + 0.04);
                osc.frequency.setValueAtTime(1047, now + 0.08);
                gain.gain.setValueAtTime(this.volume * 1.2, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
                osc.start(now);
                osc.stop(now + 0.35);
                break;

            case 'wall':
                // Very soft tap
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(200, now);
                osc.frequency.exponentialRampToValueAtTime(100, now + 0.04);
                gain.gain.setValueAtTime(this.volume * 0.3, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
                osc.start(now);
                osc.stop(now + 0.05);
                break;

            case 'win':
                // Victory fanfare
                osc.type = 'sine';
                osc.frequency.setValueAtTime(523, now);
                osc.frequency.setValueAtTime(659, now + 0.12);
                osc.frequency.setValueAtTime(784, now + 0.24);
                osc.frequency.setValueAtTime(1047, now + 0.36);
                gain.gain.setValueAtTime(this.volume, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
                osc.start(now);
                osc.stop(now + 0.5);
                break;

            case 'lose':
                // Descending sad tone
                osc.type = 'sine';
                osc.frequency.setValueAtTime(400, now);
                osc.frequency.exponentialRampToValueAtTime(150, now + 0.4);
                gain.gain.setValueAtTime(this.volume * 0.6, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
                osc.start(now);
                osc.stop(now + 0.45);
                break;

            case 'multiBall':
                // Alert ping
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, now);
                osc.frequency.setValueAtTime(660, now + 0.05);
                osc.frequency.setValueAtTime(880, now + 0.1);
                gain.gain.setValueAtTime(this.volume * 0.6, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
                osc.start(now);
                osc.stop(now + 0.15);
                break;
        }
    }
};

// === Race Countdown + Gameplay Start ===

let _gameplayStarted = false;
let _raceOverlayTimer = null;

// Show 5-second NFS-style race countdown overlay
// Uses server-provided startAtEpochMs + serverTime for clock-skew-corrected sync
function showRaceCountdown(startAtEpochMs, durationMs, serverTime) {
    console.log('[GAME] showRaceCountdown');

    resetBallAndPaddles(); // ensure paddles are visible from the first rendered frame (fixes round-1 missing paddle)

    const overlay = document.getElementById('raceOverlay');
    const numEl = document.getElementById('raceNumber');
    const labelEl = document.getElementById('raceLabel');
    if (!overlay || !numEl) { console.error('[GAME] raceOverlay elements missing'); return; }

    // Prepare game loop (renders background during countdown)
    Game.isActive = true;
    Game.roundActive = false;
    Game.roundTimeRemaining = 40;
    Game.score.player1 = 0;
    Game.score.player2 = 0;
    Game.currentRound = 1;
    Game.roundWins = { player1: 0, player2: 0 };
    Game.ball.trail = [];
    if (Game.animFrameId) cancelAnimationFrame(Game.animFrameId);
    if (Game.gameTimerInterval) { clearInterval(Game.gameTimerInterval); Game.gameTimerInterval = null; }
    document.getElementById('player1Score').textContent = '0';
    document.getElementById('player2Score').textContent = '0';
    document.getElementById('currentRound').textContent = '1';
    _loopTickCount = 0; // reset so first-tick logs appear
    gameLoop(); // start rendering background

    // Show overlay
    overlay.classList.add('active');
    labelEl.textContent = 'GET READY';
    _gameplayStarted = false;

    const totalSecs = Math.round(durationMs / 1000); // 5
    // Clock-skew correction: server's clock may differ from client's
    // clockSkew = how much server is ahead of client (positive = server ahead)
    const clockSkew = serverTime ? (serverTime - Date.now()) : 0;
    const endTime = startAtEpochMs + durationMs - clockSkew;
    console.log('[RACE] clockSkew=' + clockSkew + 'ms, endTime in ' + Math.round(endTime - Date.now()) + 'ms');

    // Clear any previous timer
    if (_raceOverlayTimer) { clearInterval(_raceOverlayTimer); _raceOverlayTimer = null; }

    function tick() {
        const remaining = Math.max(0, endTime - Date.now());
        const secsLeft = Math.ceil(remaining / 1000);

        if (secsLeft <= 0) {
            // GO!
            clearInterval(_raceOverlayTimer);
            _raceOverlayTimer = null;
            numEl.textContent = 'GO!';
            numEl.className = 'race-number go';
            labelEl.textContent = '';
            hapticFeedback('heavy');
            SFX.play('go');

            // Hide overlay after GO animation
            setTimeout(() => {
                overlay.classList.remove('active');
                numEl.className = 'race-number';
                // Start gameplay
                startGameplay();
            }, 600);
            return;
        }

        // Update number
        const prevText = numEl.textContent;
        numEl.textContent = secsLeft;

        if (prevText !== String(secsLeft)) {
            // Number changed — re-trigger animation
            if (secsLeft <= 2) {
                numEl.className = 'race-number warning';
            } else {
                numEl.className = 'race-number';
            }
            // Force animation restart
            numEl.style.animation = 'none';
            // eslint-disable-next-line no-unused-expressions
            numEl.offsetHeight; // reflow
            numEl.style.animation = '';

            hapticFeedback('light');
            SFX.play('countdown');
        }
    }

    // Initial tick
    tick();
    // Tick every 100ms for smooth sync (checks remaining ms)
    _raceOverlayTimer = setInterval(tick, 100);

    document.getElementById('gameStatus').textContent = 'Starting...';
}

// Start actual gameplay — idempotent
function startGameplay() {
    if (_gameplayStarted) {
        console.log('[GAME] startGameplay — already started, skipping');
        return;
    }
    _gameplayStarted = true;
    console.log('[GAME] startGameplay — enabling input + round');

    // Hide race overlay if still visible
    const overlay = document.getElementById('raceOverlay');
    if (overlay) overlay.classList.remove('active');

    // Clear any lingering timer
    if (_raceOverlayTimer) { clearInterval(_raceOverlayTimer); _raceOverlayTimer = null; }

    // Enable gameplay
    Game.isActive = true;
    // MP: roundActive is set by onRoundStart after server sends roundStart
    // AI: set it here immediately
    if (Game.isAIGame) Game.roundActive = true;
    startGameTimer();
    startRound();
    document.getElementById('gameStatus').textContent = Game.isAIGame ? 'Game started!' : 'Syncing...';
    hapticFeedback('medium');
}

// Report detected score to server (multiplayer only — server is authoritative)
function reportScoreToServer(scoredBy) {
    if (!Game.roundActive) return;
    Game.roundActive = false; // Freeze ball locally immediately
    hapticFeedback('medium');
    if (Game.roundTimerInterval) {
        clearInterval(Game.roundTimerInterval);
        Game.roundTimerInterval = null;
    }
    const gameId = AppState.currentGame && AppState.currentGame.id;
    if (!gameId) return;
    console.log('[SCORE] Reporting to server: scoredBy=' + scoredBy);
    sendToServer({ type: 'scoreReport', gameId, scoredBy, userId: AppState.user.id });
}

// Server broadcasts round result — freeze game and update scores
function onRoundCooldown(data) {
    const wasActive = Game.roundActive;
    if (wasActive) {
        // Non-detecting client: freeze ball, play SFX
        Game.roundActive = false;
        hapticFeedback('medium');
        if (Game.roundTimerInterval) {
            clearInterval(Game.roundTimerInterval);
            Game.roundTimerInterval = null;
        }
        // Play SFX for the client that didn't detect the score
        const iScored = (data.roundWinner === 'player1' && Game.isPlayer1) ||
                        (data.roundWinner === 'player2' && !Game.isPlayer1);
        if (data.roundWinner !== 'tie') {
            if (iScored) SFX.play('score');
            else SFX.play('scoreLost');
        }
    }

    // Update scores from authoritative server data
    Game.roundWins.player1 = data.score.player1;
    Game.roundWins.player2 = data.score.player2;
    Game.score.player1 = data.score.player1;
    Game.score.player2 = data.score.player2;
    const p1ScoreEl = document.getElementById('player1Score');
    const p2ScoreEl = document.getElementById('player2Score');
    p1ScoreEl.textContent = data.score.player1;
    p2ScoreEl.textContent = data.score.player2;

    // Flash the score that just changed
    const iScored2 = (data.roundWinner === 'player1' && Game.isPlayer1) ||
                     (data.roundWinner === 'player2' && !Game.isPlayer1);
    if (data.roundWinner !== 'tie') {
        const scoredEl = iScored2 ? (Game.isPlayer1 ? p1ScoreEl : p2ScoreEl)
                                  : (Game.isPlayer1 ? p2ScoreEl : p1ScoreEl);
        scoredEl.classList.remove('scored');
        void scoredEl.offsetWidth; // force reflow to restart animation
        scoredEl.classList.add('scored');
        setTimeout(() => scoredEl.classList.remove('scored'), 400);
    }

    // Show result text
    const resultText = data.roundWinner === 'tie' ? 'Time up - Tie!' :
                       iScored2 ? 'You scored!' : 'Opponent scored!';
    document.getElementById('gameStatus').textContent = resultText;
}

// Server signals next round — show countdown then start
function onRoundResume(data) {
    Game.currentRound = data.currentRound;
    document.getElementById('currentRound').textContent = data.currentRound;
    document.getElementById('gameStatus').textContent = 'Round ' + data.currentRound + ' of 3';
    showRoundCountdown(); // shows 3-2-1-GO then calls startRound()
}

// Server signals game over — show result screen with authoritative data
function onGameOver(data) {
    Game.isActive = false;
    Game.roundActive = false;
    if (Game.gameTimerInterval) { clearInterval(Game.gameTimerInterval); Game.gameTimerInterval = null; }
    if (Game.roundTimerInterval) { clearInterval(Game.roundTimerInterval); Game.roundTimerInterval = null; }
    if (_raceOverlayTimer) { clearInterval(_raceOverlayTimer); _raceOverlayTimer = null; }

    hapticFeedback('heavy');

    if (data.newBalance !== undefined) updateBalance(data.newBalance);

    const resultTitle = document.getElementById('resultTitle');
    const amountWonEl  = document.getElementById('amountWon');
    const finalScore   = document.getElementById('finalScore');
    const newBalanceEl = document.getElementById('newBalance');

    const iWon  = data.winnerId && data.winnerId === AppState.user.id;
    const isTie = !data.winnerId || data.winnerId === 'tie';

    // Persist result to DB
    if (typeof finishDBMatch === 'function') finishDBMatch(!!iWon);

    // Clear any grace period banner that may still be showing
    if (typeof window.clearGraceCountdown === 'function') window.clearGraceCountdown();

    if (isTie) {
        resultTitle.textContent = 'Draw!';
        resultTitle.className = 'draw';
        amountWonEl.textContent = 'Bets Returned';
        amountWonEl.className = '';
        hapticFeedback('medium');
    } else if (iWon) {
        resultTitle.textContent = 'You Won!';
        resultTitle.className = 'win';
        amountWonEl.textContent = '+$' + (data.winAmount || 0).toFixed(2);
        amountWonEl.className = 'amount-won';
        hapticFeedback('success');
        SFX.play('win');
        if (typeof window.launchConfetti === 'function') window.launchConfetti();
    } else {
        resultTitle.textContent = 'You Lost';
        resultTitle.className = 'lose';
        amountWonEl.textContent = '-$' + (data.betAmount || 0).toFixed(2);
        amountWonEl.className = 'amount-lost';
        hapticFeedback('error');
        SFX.play('lose');
    }

    if (data.score) {
        const myScore  = Game.isPlayer1 ? data.score.player1 : data.score.player2;
        const oppScore = Game.isPlayer1 ? data.score.player2 : data.score.player1;
        finalScore.textContent = myScore + '-' + oppScore;
    }
    if (newBalanceEl && data.newBalance !== undefined) newBalanceEl.textContent = data.newBalance.toFixed(2);
    if (typeof window.setResultMatchId === 'function') window.setResultMatchId(data.matchId || Game.gameId || '');

    // Tappable opponent name under result title
    const opponentName = Game.isPlayer1
        ? (AppState.currentGame && AppState.currentGame.player2Name)
        : (AppState.currentGame && AppState.currentGame.player1Name);
    const opEl = document.getElementById('resultOpponent');
    if (opEl && opponentName) {
        opEl.style.display = 'block';
        opEl.innerHTML = `vs <span style="color:#4fd1c5;cursor:pointer;text-decoration:underline;" onclick="openProfile('${opponentName}')">${opponentName}</span>`;
    }

    // Emoji reactions — reset and show
    const emojiSection = document.getElementById('emojiSection');
    if (emojiSection) {
        emojiSection.style.display = 'block';
        document.querySelectorAll('.emoji-btn').forEach(b => { b.disabled = false; b.style.opacity = '1'; });
    }
    const emojiRecv = document.getElementById('emojiReceived');
    if (emojiRecv) emojiRecv.style.display = 'none';

    // Reset fairness result from previous match
    const fairEl = document.getElementById('fairnessResult');
    if (fairEl) fairEl.style.display = 'none';

    // ELO change display
    const eloRow = document.getElementById('eloChangeRow');
    if (eloRow && data.eloChange !== undefined && !isTie) {
        const prevElo = (data.newElo || 1000) - data.eloChange;
        const sign = data.eloChange >= 0 ? '+' : '';
        document.getElementById('eloChangeText').textContent = prevElo + ' (' + sign + data.eloChange + ')';
        document.getElementById('eloNewText').textContent = data.newElo;
        document.getElementById('eloChangeText').style.color = data.eloChange >= 0 ? '#22c55e' : '#ef4444';
        eloRow.style.display = 'block';
    } else if (eloRow) {
        eloRow.style.display = 'none';
    }

    // Show rematch button and store match info for rematch request
    const rematchSection = document.getElementById('rematchSection');
    if (rematchSection) {
        rematchSection.style.display = 'block';
        window._lastMatchId = data.matchId;
        if (typeof startRematchCountdown === 'function') startRematchCountdown();
    }

    // Double or nothing — only loser gets the option
    const doubleBtn = document.getElementById('doubleOrNothingBtn');
    if (doubleBtn) {
        if (!isTie && !iWon) {
            const doubleAmt = (data.betAmount || 0) * 2;
            const doubleAmtEl = document.getElementById('doubleOrNothingAmount');
            if (doubleAmtEl) doubleAmtEl.textContent = doubleAmt.toFixed(2);
            doubleBtn.style.display = '';
            window._doubleMatchId = data.matchId;
        } else {
            doubleBtn.style.display = 'none';
        }
    }
    // Hide any stale incoming double offer banner
    const doubleOfferBanner = document.getElementById('doubleOfferBanner');
    if (doubleOfferBanner) doubleOfferBanner.style.display = 'none';

    const reportBtn = document.getElementById('reportMatchBtn');
    if (reportBtn) reportBtn.style.display = 'block';

    setTimeout(() => { showScreen('resultScreen'); }, 1000);
}

// Apply server-authoritative game state to local render state
// Ball is stored as an extrapolation origin; opponent paddle is lerped each frame
function applyServerGameState(data) {
    if (!Game.isActive || Game.isAIGame) return;

    const sx = Game.canvas.width  / SERVER_WORLD_W;
    const sy = Game.canvas.height / SERVER_WORLD_H;

    if (data.ball) {
        const svX = data.ball.x * sx;
        const svY = data.ball.y * sy;
        // Snap if too far off (reconnect / large correction)
        const dx = svX - Game.ball.x, dy = svY - Game.ball.y;
        if (dx * dx + dy * dy > 50 * 50) {
            Game.ball.x = svX;
            Game.ball.y = svY;
        }
        // Store as extrapolation origin
        Game.ball._svX    = svX;
        Game.ball._svY    = svY;
        Game.ball._svT    = performance.now();
        Game.ball._ramp   = data.ramp !== undefined ? data.ramp : 1.0;
        Game.ball.speedX  = data.ball.speedX * sx;
        Game.ball.speedY  = data.ball.speedY * sy;
        Game.ball.trail.push({ x: Game.ball.x, y: Game.ball.y });
        if (Game.ball.trail.length > 8) Game.ball.trail.shift();
    }

    // Own paddle: updated locally for zero-latency feel
    // Opponent paddle: store target, lerp each frame
    if (Game.isPlayer1) {
        if (data.paddle2X !== undefined) {
            Game.paddle2._targetX = data.paddle2X * sx;
            Game.paddle2.width    = SERVER_PADDLE_W * sx;
        }
        Game.paddle1.width = SERVER_PADDLE_W * sx;
    } else {
        if (data.paddle1X !== undefined) {
            Game.paddle1._targetX = data.paddle1X * sx;
            Game.paddle1.width    = SERVER_PADDLE_W * sx;
        }
        Game.paddle2.width = SERVER_PADDLE_W * sx;
    }
}

// Called when server sends 'roundStart' — both clients have signaled ready
function onRoundStart(data) {
    console.log('[ROUND] onRoundStart round=' + data.currentRound);
    Game.currentRound = data.currentRound;
    document.getElementById('currentRound').textContent = data.currentRound;
    document.getElementById('gameStatus').textContent = 'Round ' + data.currentRound + ' of 3';

    // Apply initial ball and paddle positions from server
    applyServerGameState({ ball: data.ball, paddle1X: data.paddle1X, paddle2X: data.paddle2X });

    Game.roundActive = true;
    Game.roundTimeRemaining = 40;

    // Display-only timer (server owns the authoritative 40s; client just shows countdown)
    if (Game.roundTimerInterval) clearInterval(Game.roundTimerInterval);
    Game.roundTimerInterval = setInterval(() => {
        if (!Game.roundActive) return;
        Game.roundTimeRemaining--;
        if (Game.roundTimeRemaining <= 0) {
            clearInterval(Game.roundTimerInterval);
            Game.roundTimerInterval = null;
        }
    }, 1000);

    hapticFeedback('medium');
}

// Export game functions
window.initGame = initGame;
window.startGame = startGame;
window.updateGame = updateGame;
window.endGame = endGame;
window.showRaceCountdown = showRaceCountdown;
window.startGameplay = startGameplay;
window.onRoundCooldown = onRoundCooldown;
window.onRoundResume = onRoundResume;
window.onGameOver = onGameOver;
window.applyServerGameState = applyServerGameState;
window.onRoundStart = onRoundStart;
window.SFX = SFX;
