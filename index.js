require("dotenv").config();

const WebSocket = require("ws");
const express = require("express");
//const WaveFile = require("wavefile").WaveFile;
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
// NEW: server-side transcript aggregator to keep Next.js unchanged
let turnStore = new Map(); // order_key -> committed paragraph text
let liveLine = ""; // current interim line
let currentRecording = null; // Store the current recording information

// Track active connections
const activeConnections = new Set();

// Handle Web Socket Connection
wss.on("connection", function connection(ws, req) {
  const origin = String(req.headers.origin || "").toLowerCase();
  // Node demo usually runs on :8080, Next.js on :3000 (or anything else).
  // Send per-turn to the demo, cumulative to everyone else.
  ws.broadcastMode = origin.includes("localhost:8080") ? "turn" : "full";
  console.log("New Connection Initiated");
  activeConnections.add(ws);

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

  ws.on("close", () => {
    console.log("Client disconnected");
    activeConnections.delete(ws);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
    activeConnections.delete(ws);
  });

  ws.on("message", function incoming(message) {
    const messageStr = message.toString();
    console.log("on message49");

    try {
      const msg = JSON.parse(messageStr);

      switch (msg.event) {
        case "connected": {
          console.log("A new call has connected.");

          // v3: simplify — handle Begin/Turn/Termination and forward transcript
          assembly.onerror = (error) => {
            console.error("AssemblyAI WebSocket error1:", error);
          };

          assembly.onmessage = (assemblyMsg) => {
            try {
              const evt = JSON.parse(assemblyMsg.data);

              if (evt.type === "Begin") {
                console.log("[AAI v3] Begin");

                // reset server-side accumulators
                turnStore = new Map();
                liveLine = "";
                latestTranscription = "";

                // NEW: push a clear message to every connected client
                const clearPayload = {
                  event: "interim-transcription", // same event your clients already handle
                  text: "", // empty clears the UI
                  end_of_turn: false,
                  order_key: -1,
                  turn_is_formatted: false,
                  reset: true, // harmless extra flag if you ever want it
                };

                activeConnections.forEach((client) => {
                  if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(clearPayload));
                  }
                });

                return;
              }

              if (evt.type === "Turn" && evt.transcript) {
                latestTranscription = evt.transcript;

                // Derive a stable numeric order key:
                // Prefer fields that often exist on v3 events; fall back safely.
                const orderKey = Number.isFinite(Number(evt.turn_order))
                  ? Number(evt.turn_order)
                  : Number.isFinite(Number(evt.audio_start))
                  ? Number(evt.audio_start)
                  : Number.isFinite(Number(evt.start_ms))
                  ? Number(evt.start_ms)
                  : Date.now(); // last resort (monotonic enough within a session)

                // (orderKey is already computed above)
                const text = String(evt.transcript || "").trim();

                // Update server-side aggregator
                if (evt.end_of_turn) {
                  // Commit finished paragraph
                  turnStore.set(orderKey, text);
                  liveLine = "";
                } else if (evt.turn_is_formatted && turnStore.has(orderKey)) {
                  // Update an already-committed paragraph with formatted text
                  turnStore.set(orderKey, text);
                  liveLine = "";
                } else {
                  // Show the live (interim) line while speaking
                  liveLine = text;
                }

                // Build the full transcript (committed + live)
                const ordered = Array.from(turnStore.entries())
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([, t]) => t);

                const full = evt.end_of_turn
                  ? ordered.join("\n")
                  : [...ordered, liveLine].filter(Boolean).join("\n");

                // Keep your existing “latest” for the REST endpoint too
                latestTranscription = full;

                // Send the same event your Next.js client already expects,
                // but with the cumulative transcript in `text`
                const payload = {
                  event: "interim-transcription",
                  text: evt.transcript,
                  end_of_turn: !!evt.end_of_turn,
                  order_key: orderKey,
                  turn_is_formatted: !!evt.turn_is_formatted,
                };

                activeConnections.forEach((client) => {
                  if (client.readyState !== WebSocket.OPEN) return;
                  const textForClient =
                    client.broadcastMode === "full" ? full : text; // cumulative vs per-turn

                  client.send(
                    JSON.stringify({
                      event: "interim-transcription",
                      text: textForClient,
                      end_of_turn: !!evt.end_of_turn,
                      order_key: orderKey,
                      turn_is_formatted: !!evt.turn_is_formatted,
                    })
                  );
                });
              }
            } catch (e) {
              // ignore control frames / non-JSON
            }
          };

          break;
        }

        case "start": {
          console.log(`Starting Media Stream ${msg.streamSid}`);
          break;
        }

        case "media": {
          // ⬇️ ONLY guard 'media' frames — don't block other events
          if (!assembly || assembly.readyState !== WebSocket.OPEN) {
            console.error(
              "AssemblyAI WebSocket not ready; dropping media frame"
            );
            break;
          }

          const b64 = msg.media?.payload;
          if (!b64) break;

          // Twilio sends ~20ms μ-law frames @ 8kHz; v3 accepts raw μ-law bytes
          const frame = Buffer.from(b64, "base64");

          // keep ~100ms batching (5 × 20ms) before sending
          chunks.push(frame);
          if (chunks.length >= 5) {
            const audioBuffer = Buffer.concat(chunks);
            try {
              assembly.send(audioBuffer); // v3: send RAW BYTES (no JSON)
            } catch (error) {
              console.error(
                "Error sending audio data to AssemblyAI v3:",
                error
              );
            }
            chunks = [];
          }
          break;
        }

        case "ping": {
          console.log("Ping Received");
          ws.send(JSON.stringify({ event: "pong" }));
          break;
        }

        case "stop": {
          console.log("Call Has Ended");
          try {
            // v3: no terminate_session payload — just close
            assembly.close();
          } catch (error) {
            console.error("Error terminating AssemblyAI session:", error);
          }
          break;
        }

        default:
          // ignore unknown events
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

  // Reset recording state and clear transcription for new call
  currentRecording = null;
  turnStore = new Map();
  liveLine = "";
  latestTranscription = "";

  // Notify all clients to clear their transcription
  activeConnections.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          event: "interim-transcription",
          text: "",
          end_of_turn: false,
          order_key: -1,
          turn_is_formatted: false,
          reset: true,
        })
      );
    }
  });

  // Close and reinitialize AssemblyAI WebSocket
  if (assembly) {
    try {
      assembly.close();
    } catch (error) {
      console.log("Error closing existing WebSocket:", error);
    }
  }
  await initAssemblyWebSocket();

  try {
    const isProduction = process.env.VERCEL_ENV === "production";
    const formattedNumber = phoneNumber.startsWith("+")
      ? phoneNumber
      : `+${phoneNumber}`;
    const wsUrl = `wss://${process.env.VERCEL_URL}`;

    const recordingStatusCallback =
      process.env.VERCEL_ENV === "production"
        ? "https://call-transcribe-heroku-b15b1132d70f.herokuapp.com/recording-status" // prod
        : "https://1c379d9a56cb.ngrok-free.app/recording-status"; // update ngrok here and .env

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

  // if (recordingStatus.RecordingStatus === "completed") {
  // Store recording information when it's complete
  currentRecording = {
    recordingSid: recordingStatus.RecordingSid,
    recordingUrl: recordingStatus.RecordingUrl,
    recordingDuration: recordingStatus.RecordingDuration,
    recordingChannels: recordingStatus.RecordingChannels,
    recordingStatus: recordingStatus.RecordingStatus,
    recordingStartTime: recordingStatus.RecordingStartTime,
    callSid: recordingStatus.CallSid,
  };

  // Print the recording object when call ends
  console.log("Call Recording Completed:");
  console.log(JSON.stringify(currentRecording, null, 2));

  activeConnections.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        console.log("sent message to frontend==");
        client.send(
          JSON.stringify({
            event: "update_recording_status",
            result: currentRecording,
          })
        );
      } catch (error) {
        console.error("Error broadcasting transcription:", error);
      }
    }
  });

  const message = currentRecording.recordingStatus;

  res.status(200).send({
    status: "ok",
    message: message,
  });
});

// Handle outbound calls
app.post("/", async (req, res) => {
  try {
    // Initialize AssemblyAI WebSocket with timeout and error handling
    const v3Url = new URL("wss://streaming.assemblyai.com/v3/ws");
    v3Url.searchParams.set("sample_rate", "8000"); // Twilio is 8kHz
    v3Url.searchParams.set("encoding", "pcm_mulaw"); // Twilio sends μ-law

    assembly = new WebSocket(v3Url, {
      headers: { Authorization: ASSEMBLY_AI_KEY }, // note: 'Authorization'
      handshakeTimeout: 10000,
    });

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

const initAssemblyWebSocket = async () => {
  try {
    const v3UrlA = new URL("wss://streaming.assemblyai.com/v3/ws");
    v3UrlA.searchParams.set("sample_rate", "8000");
    v3UrlA.searchParams.set("encoding", "pcm_mulaw");

    assembly = new WebSocket(v3UrlA, {
      headers: { Authorization: ASSEMBLY_AI_KEY }, // note capital-A
      handshakeTimeout: 10000,
    });

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

    // Always return a promise that resolves when connection is ready
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 10000);

      assembly.onopen = () => {
        console.log("assembly websocket initiated!");
        clearTimeout(timeout);
        resolve();
      };

      assembly.onerror = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    });
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
