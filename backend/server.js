const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const mysql = require("mysql2/promise");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:5174",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:5174",
    ],
    credentials: true,
  })
);
app.use(express.json());

// MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Create tables if not exist
async function createTables() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        text TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Tables created or already exist");
  } catch (err) {
    console.error("Error creating tables:", err);
  }
}

createTables();

// Register
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.execute("INSERT INTO users (username, password) VALUES (?, ?)", [
      username,
      hashedPassword,
    ]);
    res.status(201).send("User registered");
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      res.status(400).send("Username already exists");
    } else {
      res.status(500).send("Server error");
    }
  }
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );
    if (
      rows.length === 0 ||
      !(await bcrypt.compare(password, rows[0].password))
    ) {
      return res.status(401).send("Invalid credentials");
    }
    const token = jwt.sign({ username }, process.env.JWT_SECRET || "secret");
    res.json({ token });
  } catch (err) {
    res.status(500).send("Server error");
  }
});

// Middleware to verify token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).send("Access denied");
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET || "secret");
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).send("Invalid token");
  }
};

// Get messages
app.get("/messages", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT id, username, text, timestamp FROM messages ORDER BY timestamp ASC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).send("Server error");
  }
});

const messageStatus = {};

io.on("connection", (socket) => {
  console.log("User connected");
  socket.on("join", async (username) => {
    socket.username = username;
    try {
      const [rows] = await pool.execute(
        "SELECT id, username, text, timestamp FROM messages ORDER BY timestamp ASC"
      );
      socket.emit("previous messages", rows);
    } catch (err) {
      console.error("Error fetching messages:", err);
    }
  });
  socket.on("send message", async (data, callback) => {
    console.log("Received message from", socket.username, ":", data.text);
    try {
      await pool.execute(
        "INSERT INTO messages (username, text) VALUES (?, ?)",
        [socket.username, data.text]
      );
      const [rows] = await pool.execute(
        "SELECT id, username, text, timestamp FROM messages WHERE id = LAST_INSERT_ID()"
      );
      const message = rows[0];

      const recipients = Array.from(io.sockets.sockets.values()).filter(
        (clientSocket) => clientSocket.id !== socket.id && clientSocket.username
      );
      const expectedRecipients = recipients.length;

      messageStatus[message.id] = {
        senderId: socket.id,
        expectedRecipients,
        seenBy: new Set(),
        seenByUsernames: new Set(),
      };

      if (callback) {
        callback({ message, delivered: expectedRecipients > 0 });
      }

      recipients.forEach((recipientSocket) => {
        recipientSocket.emit("receive message", message);
      });
    } catch (err) {
      console.error("Error saving message:", err);
      if (callback) callback({ error: "Unable to save message" });
    }
  });

  socket.on("message seen", ({ messageId }) => {
    const status = messageStatus[messageId];
    if (!status || socket.id === status.senderId) return;

    if (!status.seenBy.has(socket.id)) {
      status.seenBy.add(socket.id);
      if (socket.username) status.seenByUsernames.add(socket.username);
    }

    const allSeen =
      status.expectedRecipients > 0 &&
      status.seenBy.size === status.expectedRecipients;

    io.to(status.senderId).emit("message status", {
      messageId,
      status: allSeen ? "seen" : "delivered",
      seenBy: Array.from(status.seenByUsernames),
      allSeen,
    });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
