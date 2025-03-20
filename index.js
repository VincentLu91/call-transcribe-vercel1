const WebSocket = require("ws");
const express = require("express");
const WaveFile = require("wavefile").WaveFile;
const path = require("path");

// Environment variables
const ASSEMBLY_AI_KEY =
  process.env.ASSEMBLY_AI_KEY || "8acedd22ef7542259df0f36dc8bf18ac";
const PORT = process.env.PORT || 8080;

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({
  server,
  handleProtocols: () => "protocolOne", // Handle WebSocket protocol negotiation
});

let assembly;
let chunks = [];
let latestTranscription = ""; // Store the latest transcription

// Handle Web Socket Connection
wss.on("connection", function connection(ws) {
  console.log("New Connection Initiated");

  // Send initial connection message with error handling
  try {
    ws.send(
      JSON.stringify({
        event: "connected",
        message: "WebSocket connection established",
      })
    );
  } catch (error) {
    console.error("Error sending connection message:", error);
  }

  ws.on("message", function incoming(message) {
    if (!assembly) {
      console.error("AssemblyAI's WebSocket must be initialized.");
      return;
    }

    try {
      const msg = JSON.parse(message);
      switch (msg.event) {
        case "connected":
          console.log(`A new call has connected.`);
          assembly.onerror = (error) => {
            console.error("AssemblyAI WebSocket error:", error);
          };

          const texts = {};
          assembly.onmessage = (assemblyMsg) => {
            try {
              const res = JSON.parse(assemblyMsg.data);
              texts[res.audio_start] = res.text;
              const keys = Object.keys(texts);
              keys.sort((a, b) => a - b);
              let msg = "";
              for (const key of keys) {
                if (texts[key]) {
                  msg += ` ${texts[key]}`;
                }
              }
              console.log(msg);
              latestTranscription = msg; // Store the latest transcription

              // Broadcast to all connected clients
              wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                  try {
                    client.send(
                      JSON.stringify({
                        event: "interim-transcription",
                        text: msg,
                      })
                    );
                  } catch (error) {
                    console.error("Error broadcasting transcription:", error);
                  }
                }
              });
            } catch (error) {
              console.error("Error processing AssemblyAI message:", error);
            }
          };
          break;

        case "start":
          console.log(`Starting Media Stream ${msg.streamSid}`);
          break;

        case "media":
          const twilioData = msg.media.payload;
          // Build the wav file from scratch since it comes in as raw data
          let wav = new WaveFile();

          // Twilio uses MuLaw so we have to encode for that
          wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64"));

          // This library has a handy method to decode MuLaw straight to 16-bit PCM
          wav.fromMuLaw();

          // Get the raw audio data in base64
          const twilio64Encoded = wav.toDataURI().split("base64,")[1];

          // Create our audio buffer
          const twilioAudioBuffer = Buffer.from(twilio64Encoded, "base64");

          // Send data starting at byte 44 to remove wav headers so our model sees only audio data
          chunks.push(twilioAudioBuffer.slice(44));

          // We have to chunk data b/c twilio sends audio durations of ~20ms and AAI needs a min of 100ms
          if (chunks.length >= 5) {
            const audioBuffer = Buffer.concat(chunks);
            const encodedAudio = audioBuffer.toString("base64");
            try {
              assembly.send(JSON.stringify({ audio_data: encodedAudio }));
            } catch (error) {
              console.error("Error sending audio data to AssemblyAI:", error);
            }
            chunks = [];
          }
          break;

        case "stop":
          console.log(`Call Has Ended`);
          try {
            assembly.send(JSON.stringify({ terminate_session: true }));
          } catch (error) {
            console.error("Error terminating AssemblyAI session:", error);
          }
          break;
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  });
});

//Handle HTTP Request
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "/index.html")));

// API endpoint to get the latest transcription
app.get("/api/transcription", (req, res) => {
  res.json({ transcription: latestTranscription });
});

app.post("/", async (req, res) => {
  try {
    // Initialize AssemblyAI WebSocket with timeout and error handling
    assembly = new WebSocket(
      "wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000",
      {
        headers: { authorization: ASSEMBLY_AI_KEY },
        handshakeTimeout: 10000, // 10 second timeout
      }
    );

    // Handle connection errors
    assembly.onerror = (error) => {
      console.error("AssemblyAI WebSocket error:", error);
    };

    // Construct WebSocket URL based on request headers
    const protocol = req.headers["x-forwarded-proto"] || "ws";
    const wsProtocol = protocol === "https" ? "wss" : "ws";
    const host = req.headers["x-forwarded-host"] || req.headers.host;

    res.set("Content-Type", "text/xml");
    res.send(
      `<Response>
         <Start>
           <Stream url='${wsProtocol}://${host}' />
         </Start>
         <Say>
           Start speaking to see your audio transcribed in the console
         </Say>
         <Pause length='30' />
       </Response>`
    );
  } catch (error) {
    console.error("Error initializing AssemblyAI connection:", error);
    res.status(500).send("Error initializing transcription service");
  }
});

// Start server
console.log(`Listening at Port ${PORT}`);
server.listen(PORT);

// Export the Express API
module.exports = app;
