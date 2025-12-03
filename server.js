"use strict";

const express = require("express");
const socketIO = require("socket.io");
const path = require("path");
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
let players = {};  // Store player data
// Track connected users
let userCount = 0;
let isHost = null; // Track the host player

let ballData = {
    x: 400,
    y: 300,
    vx: 3,
    vy: 0
}; // Initial ball data
let playerObjects = []; // Array to hold all player objects

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

    // Send the initial player and ball state to the client
    socket.emit('initialState', { players, ballData });

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

    // Listen for ball updates
    socket.on('updateBall', (data) => {
        ballData = data;
        socket.broadcast.emit('updateBall', ballData);  // Sync ball across clients
    });

    // Handle player disconnects
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        // Remove the player from the list of players
        delete players[socket.id];

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