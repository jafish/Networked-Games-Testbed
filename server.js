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

const server = express()
  .use((req, res) => res.sendFile(INDEX))
  .listen(PORT, () => console.log(`Listening on ${PORT}`));

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
let lastPaddleHit = null; // Track who last hit the ball with their paddle
let isHost = null;

// Helper function to get randomized spawn velocity
function getRandomSpawnVelocity() {
  const speed = 1.2 + Math.random() * 0.6; // Random speed between 1.2 and 1.8
  const angle = (Math.random() - 0.5) * 0.6; // Random angle between -0.3 and 0.3 radians
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

// Game loop: simple manual physics
const gameLoopInterval = setInterval(() => {
  // Use sub-stepping for collision detection (4 steps per frame)
  const substeps = 4;
  const substepVx = ballState.vx / substeps;
  const substepVy = ballState.vy / substeps;
  const gravityPerStep = 0.2 / substeps; // Reduced gravity - distribute across substeps
  
  for (let i = 0; i < substeps; i++) {
    // Apply gravity for this substep
    ballState.vy += gravityPerStep;
    
    // Update position
    ballState.x += substepVx;
    ballState.y += substepVy;
    
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
    
    // Floor reset (don't let it go out of bounds)
    if (ballState.y + BALLRADIUS > CANVASY) {
      ballState.x = BALLSPAWNX;
      ballState.y = BALLSPAWNY;
      ballState.vx = 1.5;
      ballState.vy = 0.3;
      lastPaddleHit = null;
    }
  }
  
  // Goal detection
  if (ballState.x > 750 && ballState.x < 800 &&
      ballState.y > 250 && ballState.y < 350) {
    if (lastPaddleHit && scores[lastPaddleHit] !== undefined) {
      scores[lastPaddleHit]++;
      console.log(`${lastPaddleHit} scored! Score: ${scores[lastPaddleHit]}`);
    }
    ballState.x = BALLSPAWNX;
    ballState.y = BALLSPAWNY;
    const spawnVel = getRandomSpawnVelocity();
    ballState.vx = spawnVel.vx;
    ballState.vy = spawnVel.vy;
    lastPaddleHit = null;
  }
  
  // Broadcast ball state
  ballData = { x: ballState.x, y: ballState.y, vx: ballState.vx, vy: ballState.vy };
  io.emit('ballUpdate', ballData);
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
    
    // Initialize score for this player
    scores[socket.id] = 0;

    // Send the initial player and ball state to the client
    // Include the receiver's socket id so the client can map its local body
    socket.emit('initialState', { players, ballData, scores, you: socket.id });

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
            
            // Server-side paddle collision detection with rotation
            const paddleX = data.x;
            const paddleY = data.y - 30;
            const paddleW = 90;
            const paddleH = 15;
            const paddleRotation = data.paddleRotation;
            
            // Calculate rotated paddle corners
            const cos_r = Math.cos(paddleRotation);
            const sin_r = Math.sin(paddleRotation);
            
            // Distance from ball to paddle center
            const dx = ballState.x - paddleX;
            const dy = ballState.y - paddleY;
            
            // Rotate ball position relative to paddle (to test AABB collision in paddle space)
            const localX = dx * cos_r + dy * sin_r;
            const localY = -dx * sin_r + dy * cos_r;
            
            // AABB collision in paddle-local space (with margin for accuracy)
            const collisionMargin = 8;
            if (Math.abs(localX) < paddleW / 2 + BALLRADIUS + collisionMargin &&
                Math.abs(localY) < paddleH / 2 + BALLRADIUS + collisionMargin) {
                // When collision detected - bounce ball upward with stronger force on paddle hit
                ballState.vy = -Math.abs(ballState.vy) * 0.8 - 1;
                ballState.vx = ballState.vx * 0.75;
                lastPaddleHit = socket.id;
            }
        }
    });

    // Old ball update handler removed - server now controls ball physics

    // Handle player disconnects
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        // Remove the player from the list of players
        delete players[socket.id];

        // Remove their score
        delete scores[socket.id];

        // Notify other players that this player has disconnected
        socket.broadcast.emit('playerDisconnected', socket.id);

        // Re-assign the host if needed
        if (socket.id === isHost) {
            setNewHost();
        }
    });

    // Set a new host if needed
    function setNewHost() {
        if (Object.keys(players).length > 0) {
            isHost = Object.keys(players)[0];  // Set the first player as the new host
            io.emit('hostChanged', isHost);    // Notify all clients of the host change
        } else {
            isHost = null;
        }
    }
    
    // Set the initial host if no host exists
    if (!isHost) {
        setNewHost();
    }
});