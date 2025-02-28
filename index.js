const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const { DisconnectReason } = require("@whiskeysockets/baileys");
const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const socketIo = require("socket.io");
const qrcode = require("qrcode");


const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

const localFolderPath = path.normalize(path.join(__dirname, "auth_info_baileys"));

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Serve the QR code page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

let sock = null;
let connectionState = "disconnected";

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(localFolderPath);
    sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      keepAliveIntervalMs: 20000,
      defaultQueryTimeoutMs: 0,
      generateHighQualityLinkPreview: true,
    });

    sock.ev.on("connection.update", (update) => handleConnectionUpdate(update, sock));
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", async (messageUpdate) => handleMessagesUpsert(messageUpdate, sock));

    console.log("Connecting to WhatsApp...");
  } catch (error) {
    console.log("Error in connectToWhatsApp", error);
  }
}

function handleConnectionUpdate(update, sock) {
  const { connection, lastDisconnect, qr } = update || {};
  
  if (qr) {
    console.log("QR Code received, scan to connect!");
    // Convert QR code to data URL and emit to client
    qrcode.toDataURL(qr, (err, url) => {
      if (err) {
        console.error("Error generating QR code:", err);
        return;
      }
      io.emit("qr", { qr: url });
      connectionState = "qr";
      io.emit("connection-status", { state: connectionState });
    });
  }
  
  if (connection === "close") {
    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
    console.log("Connection closed due to ", lastDisconnect?.error, "reconnecting: ", shouldReconnect);
    connectionState = "disconnected";
    io.emit("connection-status", { state: connectionState });
    
    if (shouldReconnect) {
      connectToWhatsApp();
    }
  } else if (connection === "open") {
    console.log("Connected to WhatsApp!");
    connectionState = "connected";
    io.emit("connection-status", { state: connectionState });
  }
}

async function handleMessagesUpsert(messageUpdate, sock) {
  try {
    const messageZero = messageUpdate.messages[0];
    const { key, message } = messageZero;
    if (!message) return;

    const { remoteJid } = key;
    const messageText = message.conversation || message.extendedTextMessage?.text;
    if (!messageText) return;

    // Execute tagging only if the text includes "@all" or "@everyone"
    if (messageText.includes("@all") || messageText.includes("@everyone")) {
      // Retrieve group metadata to check if the sender is an admin
      const groupMetadata = await sock.groupMetadata(remoteJid);
      const senderId = key.participant || key.remoteJid; // Depending on message source
      const isAdmin = groupMetadata.participants.some(participant =>
        participant.id === senderId && participant.admin !== null);

      // Proceed with tagging only if the sender is an admin
      if (isAdmin) {
        await tagAllMembers(remoteJid, sock, key);
      } else {
        console.log("Non-admin tried to use admin-only tagging command.");
      }
    }
  } catch (error) {
    console.log("Error in handleMessagesUpsert", error);
  }
}


async function tagAllMembers(remoteJid, sock, messageKey) {
  try {
    if (!messageKey.participant) return;
    const groupMetadata = await sock.groupMetadata(remoteJid);
    const myId = sock.user.id.split(":")[0];
    const participants = groupMetadata.participants;
    const filteredParticipants = participants.filter(
      (participant) => participant.id !== myId + "@s.whatsapp.net" && participant.id !== messageKey.participant
    );
    const mentions = filteredParticipants.map((p) => p.id);
    const mentionText = filteredParticipants.map((p) => `@${p.id.split("@")[0]}`).join(" ");
    const quotedMessage = {
      key: messageKey,
      message: {
        conversation: messageKey.conversation || "Quoted text",
      },
    };

    const options = {
      quoted: quotedMessage,
    };
    await sock.sendMessage(remoteJid, { text: mentionText, mentions: mentions }, options);
    console.log("Tagged all members in the group, excluding yourself");
  } catch (error) {
    console.log("Error tagging all members:", error);
  }
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("Client connected");
  // Send current connection state to new clients
  socket.emit("connection-status", { state: connectionState });
  
  // If we have a QR code and a new client connects, we need to send it
  if (connectionState === "qr" && sock) {
    // We can't resend the QR directly, but the client can refresh to get it
    socket.emit("connection-status", { state: "needsRefresh" });
  }
});

connectToWhatsApp();

server.listen(port, () => {
  console.log(`✨ Server is running on port ${port}`);
  console.log(`🌐 Open http://localhost:${port} in your browser to see the QR code`);
});
