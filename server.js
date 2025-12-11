"use strict";

const express = require("express");
const socketIO = require("socket.io");
const path = require("path");
const Matter = require("matter-js");
//const p5 = require("p5");

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, "index.html");
let FRAME_RATE = 60;
let FRAME_TIME = 1000 / FRAME_RATE;
let lastFrameTime = Date.now();

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use("/Sounds", express.static(path.join(__dirname, "Sounds")));
// Serve the index.html file and sounds
app.get("/", (req, res) => res.sendFile(INDEX));
const server = app.listen(PORT, () =>
  console.log(`Listening on port ${PORT}`)
); 
const io = socketIO(server);

// Matter.js Setup - Server-side physics
const { Engine, World, Bodies, Body } = Matter;
const engine = Engine.create();
const world = engine.world;
world.gravity.y = 0;
const CANVASX = 800;
const CANVASY = 500;
const BALLSPAWNX = 20;
const BALLSPAWNY = 50;
const BALLRADIUS = 15;

// Simple ball data for manual physics
let ballState = {
  x: BALLSPAWNX,
  y: BALLSPAWNY,
  vx: 3,
  vy: 1
};

// No Matter.js bodies for ball - just manual physics

let players = {};
let scores = {}; // Track player scores
let combos = {}; // Track combo count per player
let lastPaddleHit = null; // Track who last hit the ball with their paddle
let paddleHitCooldown = {}; // Cooldown per paddle to prevent multiple hits in one contact

// Helper function to get randomized spawn velocity
function getRandomSpawnVelocity() {
  const speed = 2.2 + Math.random() * 0.6; // Random speed between 2.2 and 2.8
  const angle = Math.random() * 0.2 - 0.05; // Random angle between -0.05 and 0.15 radians (more right-facing)
  return {
    vx: speed * Math.cos(angle),
    vy: speed * Math.sin(angle)
  };
}

let ballData = {
    x: ballState.x,
    y: ballState.y,
    vx: ballState.vx,
    vy: ballState.vy
};

// Goal position tracking
let goalY = 250;
let hitCounter = 0; // Track rally/hit count
let floorHitCount = 0; // Track consecutive floor hits

function randomizeGoalY() {
  goalY = 150 + Math.random() * 200;
}

function handlePaddleCollision(playerId, playerData) {
  if (!playerData) return;
  const paddleX = playerData.x;
  const paddleY = playerData.y - 30;
  const paddleW = 90;
  const paddleH = 15;
  const paddleRotation = playerData.paddleRotation || 0;

  const cos_r = Math.cos(paddleRotation);
  const sin_r = Math.sin(paddleRotation);

  const dx = ballState.x - paddleX;
  const dy = ballState.y - paddleY;

  const localX = dx * cos_r + dy * sin_r;
  const localY = -dx * sin_r + dy * cos_r;

  const collisionMargin = 10;
  const isColliding = Math.abs(localX) < paddleW / 2 + BALLRADIUS + collisionMargin &&
      Math.abs(localY) < paddleH / 2 + BALLRADIUS + collisionMargin;
  
  if (isColliding) {
    const restitution = 0.78;

    // Normal points outward from paddle surface (upward when angle = 0)
    const nx = sin_r;
    const ny = -cos_r;
    const vDotN = ballState.vx * nx + ballState.vy * ny;
    if (vDotN < 0) {
      ballState.vx = ballState.vx - (1 + restitution) * vDotN * nx;
      ballState.vy = ballState.vy - (1 + restitution) * vDotN * ny;
    } else {
      // If overlapping but moving away, still give a small push along the normal
      const nudge = 0.6;
      ballState.vx += nx * nudge;
      ballState.vy += ny * nudge;
    }
    const overlapY = (paddleH / 2 + BALLRADIUS + collisionMargin) - Math.abs(localY);
    if (overlapY > 0) {
      const dir = localY >= 0 ? 1 : -1;
      const correction = (overlapY + 1) * dir;
      ballState.x += nx * correction;
      ballState.y += ny * correction;
    }
    
    // Only count hit if cooldown has passed (prevent multiple hits in one contact)
    if (!paddleHitCooldown[playerId]) {
      hitCounter++; // Increment hit counter on paddle collision
      lastPaddleHit = playerId;
      paddleHitCooldown[playerId] = true; // Set cooldown
      floorHitCount = 0; // Reset floor hit counter on successful paddle hit
      io.emit('paddleHit'); // Emit event to play paddle hit sound on all clients
    }
  } else {
    // Ball no longer in contact, clear this paddle's cooldown
    paddleHitCooldown[playerId] = false;
  }
}

// Game loop: simple manual physics
const gameLoopInterval = setInterval(() => {
  // Use sub-stepping for collision detection (6 steps per fram
  // e)
  const substeps = 6;
  const gravityTotal = 0.18; // overall gravity per frame (a bit faster fall)
  const gravityPerStep = gravityTotal / substeps;
  const airDrag = 0.998; // reduced drag to preserve momentum (was 0.996)
  const maxSpeed = 10; // clamp to avoid tunneling and runaway speed
  
  for (let i = 0; i < substeps; i++) {
    // Apply gravity for this substep
    ballState.vy += gravityPerStep;
    
    // Update position
    ballState.x += ballState.vx / substeps;
    ballState.y += ballState.vy / substeps;

    // Paddle collisions for all players using latest server-side paddle angles/positions
    for (const pid in players) {
      handlePaddleCollision(pid, players[pid]);
    }
    
    // Wall bounces (with damping)
    if (ballState.x - BALLRADIUS < 0) {
      ballState.x = BALLRADIUS;
      ballState.vx = -ballState.vx * 0.9;
    }
    if (ballState.x + BALLRADIUS > CANVASX) {
      ballState.x = CANVASX - BALLRADIUS;
      ballState.vx = -ballState.vx * 0.9;
    }
    if (ballState.y - BALLRADIUS < 0) {
      ballState.y = BALLRADIUS;
      ballState.vy = Math.abs(ballState.vy) * 0.6; // Bounce down with less energy
    }

    // Gentle air drag to reduce jitter and excessive speed
    ballState.vx *= airDrag;
    ballState.vy *= airDrag;

    // Clamp speed to keep simulation stable
    const speedSq = ballState.vx * ballState.vx + ballState.vy * ballState.vy;
    if (speedSq > maxSpeed * maxSpeed) {
      const scale = maxSpeed / Math.sqrt(speedSq);
      ballState.vx *= scale;
      ballState.vy *= scale;
    }
    
    // Floor reset (don't let it go out of bounds)
    if (ballState.y + BALLRADIUS > CANVASY) {
      ballState.x = BALLSPAWNX;
      ballState.y = BALLSPAWNY;
      ballState.vx = 1.5;
      ballState.vy = 0.3;
      lastPaddleHit = null;
      paddleHitCooldown = {}; // Reset all paddle cooldowns
      floorHitCount++; // Increment floor hit counter
      
      // Reset all combos after 5 floor hits
      if (floorHitCount >= 5) {
        Object.keys(combos).forEach((id) => {
          combos[id] = 0;
        });
        io.emit('comboUpdate', combos); // Broadcast combo reset
        floorHitCount = 0; // Reset floor hit counter
      }
    }
  }
  
  // Goal detection
  if (ballState.x > 750 && ballState.x < 800 &&
      ballState.y > goalY - 50 && ballState.y < goalY + 50) {
    if (lastPaddleHit && scores[lastPaddleHit] !== undefined) {
      // Initialize combo if not exists
      if (!combos[lastPaddleHit]) {
        combos[lastPaddleHit] = 0;
      }
      // Increment combo for this player
      combos[lastPaddleHit]++;
      
      // Calculate points: 1 base point + 1 bonus per combo (so 2 points at combo 2, 3 points at combo 3, etc.)
      const comboBonus = combos[lastPaddleHit];
      const pointsEarned = 1 + comboBonus;
      scores[lastPaddleHit] += pointsEarned;
      
      console.log(`${lastPaddleHit} scored! Combo: ${combos[lastPaddleHit]} | Points: +${pointsEarned} | Total Score: ${scores[lastPaddleHit]} (Rally: ${hitCounter})`);
    }
    ballState.x = BALLSPAWNX;
    ballState.y = BALLSPAWNY;
    const spawnVel = getRandomSpawnVelocity();
    ballState.vx = spawnVel.vx;
    ballState.vy = spawnVel.vy;
    lastPaddleHit = null;
    paddleHitCooldown = {}; // Reset all paddle cooldowns
    randomizeGoalY();
    io.emit('goalYUpdate', goalY);
    io.emit('comboUpdate', combos); // Broadcast combo counts
    io.emit('hitCounterReset'); // Reset hit counter after goal
    hitCounter = 0;
  }
  
  // Broadcast ball state and hit counter
  ballData = { x: ballState.x, y: ballState.y, vx: ballState.vx, vy: ballState.vy };
  io.emit('ballUpdate', ballData);
  io.emit('hitCounterUpdate', hitCounter); // Broadcast hit counter to all clients
  io.emit('scoresUpdate', scores);
}, 1000 / 60);

//when client connects to the server
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Assign the player's initial data (you can send this to the client if necessary)
    players[socket.id] = {
        id: socket.id,
        x: Math.random() * 700 + 50,  // Random starting x position
        y: 465,  // Starting y position (on the ground)
        paddleRotation: 0,
        lastActivity: Date.now()
    };
    
    // Initialize score and combo for this player
    scores[socket.id] = 0;
    combos[socket.id] = 0;

    // Send the initial player and ball state to the client
    // Include the receiver's socket id so the client can map its local body
    socket.emit('initialState', { players, ballData, scores, goalY, you: socket.id });

    // Notify other players about the new player
    socket.broadcast.emit('newPlayer', players[socket.id]);

    // Listen for player movement updates
    socket.on('playerUpdate', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].paddleRotation = data.paddleRotation;

            // Broadcast the updated player info to all clients
            io.emit('playerUpdate', players[socket.id]);
        }
    });

    // Old ball update handler removed - server now controls ball physics

    // Handle player disconnects
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        // Remove the player from the list of players
        delete players[socket.id];

        // Remove their score and combo
        delete scores[socket.id];
        delete combos[socket.id];

        // Notify other players that this player has disconnected
        socket.broadcast.emit('playerDisconnected', socket.id);
    });
});
