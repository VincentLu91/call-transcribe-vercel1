require("dotenv").config();

const WebSocket = require("ws");
const express = require("express");
const WaveFile = require("wavefile").WaveFile;
const path = require("path");
const twilio = require("twilio");

const ASSEMBLY_AI_KEY = process.env.ASSEMBLY_AI_KEY;
console.log("ASSEMBLY_AI_KEY", ASSEMBLY_AI_KEY);
const PORT = process.env.PORT || 8080;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

console.log("process.env.VERCEL_ENV", process.env.VERCEL_ENV);
console.log("PORT", PORT);

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({
  server,
  handleProtocols: () => "protocolOne", // Handle WebSocket protocol negotiation
});

let assembly;
let chunks = [];
let latestTranscription = ""; // Store the latest transcription
let currentRecording = null; // Store the current recording information

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
    const messageStr = message.toString();
    console.log("on message49");
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
            console.error("AssemblyAI WebSocket error1:", error);
          };

          const texts = {};
          assembly.onmessage = (assemblyMsg) => {
            console.log("New message from twilio====");
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
              // console.log("New message70:", msg);
              latestTranscription = msg; // Store the latest transcription

              // Broadcast to all connected clients
              wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                  try {
                    console.log("sent message to frontend==");
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

        case "ping":
          console.log(`Ping Received`);
          ws.send(JSON.stringify({ event: "pong" }));
          break;
        case "stop":
          console.log(`Call Has Ended`);
          try {
            assembly.send(JSON.stringify({ terminate_session: true }));
            assembly.close();
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

// Add body parser middleware for JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//Handle HTTP Request
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "/index.html")));

// Make a call to a specified number
app.post("/make-call1", (req, res) => {
  const phoneNumber = req.body.phoneNumber;
  if (!phoneNumber) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  // Ensure phone number is in E.164 format
  const formattedNumber = phoneNumber.startsWith("+")
    ? phoneNumber
    : `+${phoneNumber}`;

  res.set("Content-Type", "text/xml");
  res.send(
    `<Response>
       <Dial>${formattedNumber}</Dial>
     </Response>`
  );
});

// API endpoint to get the latest transcription
app.get("/api/transcription", (req, res) => {
  res.json({ transcription: latestTranscription });
});

app.post("/make-outbounding-call", async (req, res) => {
  const phoneNumber = req.body.phoneNumber;
  if (!phoneNumber) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  // Reset recording state for new call
  currentRecording = null;

  // Always reinitialize the WebSocket for a new call
  if (assembly) {
    try {
      assembly.close();
    } catch (error) {
      console.log("Error closing existing WebSocket:", error);
    }
  }
  initAssemblyWebSocket();

  try {
    const isProduction = process.env.VERCEL_ENV === "production";
    const formattedNumber = phoneNumber.startsWith("+")
      ? phoneNumber
      : `+${phoneNumber}`;
    const wsUrl = `wss://${process.env.VERCEL_URL}`;

    const recordingStatusCallback =
      process.env.VERCEL_ENV === "production"
        ? "https://call-transcribe-heroku-b15b1132d70f.herokuapp.com/recording-status" // prod
        : "https://98f4-70-50-62-156.ngrok-free.app/recording-status"; // local ngrok temporary

    const call = await client.calls.create({
      to: formattedNumber,
      from: TWILIO_NUMBER,
      twiml: `<Response>
         <Start>
           <Stream url='${wsUrl}' />
         </Start>
         <Say>
           Start speaking to see your audio transcribed in the console
         </Say>
         <Pause length='300' />
       </Response>`,
      record: true,
      recordingStatusCallback: recordingStatusCallback,
      recordingStatusCallbackEvent: ["completed"],
    });
    console.log("call SID:", call.sid);

    // Wait for recording to complete (up to 5 minutes)
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    // while (!currentRecording && attempts < maxAttempts) {
    //   await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
    //   attempts++;
    // }
    // https responsive time should be less than 1s, ideally 100ms

    res.json({
      status: "ok",
      callSID: call.sid,
      message: "call initialized successfully",
      // recording: currentRecording,
    });
  } catch (error) {
    console.log("making a call Err:", error);
    res.json({
      status: "failed",
    });
  }
});

app.post("/outboundWebhook", async (req, res) => {
  const body = req.body;
  console.log("body", body);
  res.json({
    status: "out bound call works",
    body: body,
  });
});

// Handle recording status callbacks from Twilio
app.post("/recording-status", async (req, res) => {
  const recordingStatus = req.body;
  console.log("Recording Status:", recordingStatus);

  if (recordingStatus.RecordingStatus === "completed") {
    // Store recording information when it's complete
    currentRecording = {
      recordingSid: recordingStatus.RecordingSid,
      recordingUrl: recordingStatus.RecordingUrl,
      recordingDuration: recordingStatus.RecordingDuration,
      recordingChannels: recordingStatus.RecordingChannels,
      recordingStatus: recordingStatus.RecordingStatus,
    };

    // Print the recording object when call ends
    console.log("Call Recording Completed:");
    console.log(JSON.stringify(currentRecording, null, 2));

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          console.log("sent message to frontend==");
          client.send(
            JSON.stringify({
              event: "recording_completed",
              result: currentRecording,
            })
          );
        } catch (error) {
          console.error("Error broadcasting transcription:", error);
        }
      }
    });

    res.status(200).send({
      status: "ok",
      message: "recording in completed",
    });
  } else {
    res.status(200).send({
      status: "ok",
      message: "recording in progress",
    });
  }
});

// Handle outbound calls
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
      console.error("AssemblyAI WebSocket error2:", error);
    };

    // In production, use VERCEL_URL, otherwise fallback to request headers
    const isProduction = process.env.VERCEL_ENV === "production";
    let wsUrl;
    if (isProduction && process.env.VERCEL_URL) {
      // In production, always use wss:// with the VERCEL_URL
      wsUrl = `wss://${process.env.VERCEL_URL}`;
    } else {
      // In development, determine protocol from request
      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const wsProtocol = protocol === "https" ? "wss" : "ws";
      const host = req.headers.host;
      // wsUrl = `${wsProtocol}://${host}`;
      wsUrl = `${wsProtocol}://${process.env.VERCEL_URL}`;
    }
    console.log("wsUrl", wsUrl);

    res.set("Content-Type", "text/xml");
    res.send(
      `<Response>
         <Start>
           <Stream url='${wsUrl}' />
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

const initAssemblyWebSocket = () => {
  try {
    assembly = new WebSocket(
      "wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000",
      {
        headers: { authorization: ASSEMBLY_AI_KEY },
        handshakeTimeout: 10000, // 10 second timeout
      }
    );

    // Handle connection errors
    assembly.onerror = (error) => {
      console.error("AssemblyAI WebSocket error2:", error);
    };

    assembly.onopen = () => {
      console.log("assembly websocket initiated!");
    };

    assembly.onclose = () => {
      console.log("AssemblyAI WebSocket closed");
    };

    // Add connection state check
    if (assembly.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve) => {
        assembly.onopen = () => {
          console.log("assembly websocket initiated!");
          resolve();
        };
      });
    }
  } catch (error) {
    console.log("initAssemblyWebSocket Err:", error);
    throw error;
  }
};
// Start server
initAssemblyWebSocket();
console.log(`Listening at Port ${PORT}`);
server.listen(PORT);

// Export the Express API
module.exports = app;
