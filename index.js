require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pLimitImport = require("p-limit");
const pLimit = pLimitImport.default || pLimitImport;
const rateLimit = require("express-rate-limit");

// ---- 1. Environment Validation (Validate at startup) ----
const requiredEnv = ["GEMINI_API_KEY", "FIREBASE_SERVICE_ACCOUNT_BASE64", "CRON_SECRET"];
requiredEnv.forEach(v => {
  if (!process.env[v]) {
    console.error(`ERROR: Missing required environment variable: ${v}`);
    process.exit(1);
  }
});

const app = express();
app.use(express.json());

// ---- 2. Rate Limiting ----
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 requests per windowMs
  message: { error: "Too many requests, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Initialize Gemini with the API Key from environment variables
// Note: You must set this in your Render dashboard environment variables
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper to discover which models are actually available for the current API Key
async function listAvailableModels() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.models) {
      const names = data.models.map(m => m.name.replace("models/", ""));
      console.log("AI DEBUG: Available models for this key:", names);
      return names;
    }
    console.warn("AI DEBUG: No models found in ListModels response:", data);
  } catch (e) {
    console.error("AI DEBUG: Failed to list models:", e.message);
  }
  return [];
}

// Helper to try multiple models in case of regional quota or model unavailability errors
// imageData: optional { mimeType: string, base64: string }
async function callGemini(message, history = [], systemPrompt = "", isDraft = false, imageData = null) {
  const models = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-flash-latest",
    "gemini-pro-latest",
    "gemini-2.5-pro",
    "gemini-pro"
  ];
  let lastError = null;

  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName }, { apiVersion: "v1beta" });
      
      if (isDraft) {
        // For advisories/drafts
        const fullPrompt = `${systemPrompt}\n\nUser Task: ${message}`;
        const result = await model.generateContent(fullPrompt);
        return result.response.text().trim();
      } else {
        // For chat with history (and optional image)
        const chatHistory = [
          { role: "user", parts: [{ text: systemPrompt }] },
          { role: "model", parts: [{ text: "Understood. I am Minda, and I am ready to help you with your farm. Zvakanaka!" }] },
          ...history.map(h => ({
            role: h.role === "user" ? "user" : "model",
            parts: [{ text: h.text }]
          }))
        ];
        const chat = model.startChat({ history: chatHistory });

        // Build multimodal parts if an image is included
        let messageParts;
        if (imageData) {
          messageParts = [
            {
              inlineData: {
                mimeType: imageData.mimeType,
                data: imageData.base64,
              }
            },
            { text: message || "Please analyse this image." }
          ];
        } else {
          messageParts = message;
        }

        const result = await chat.sendMessage(messageParts);
        return result.response.text();
      }
    } catch (err) {
      lastError = err;
      console.warn(`Model ${modelName} failed:`, err.message);
      
      // PERMISSIVE FALLBACK: Try the next model for ANY error (404, 403, 429, etc.)
      console.log(`Retrying with next model after ${modelName} failed...`);
      continue;
    }
  }

  // If we reach here, all hardcoded models failed. Try discovery as a last resort.
  console.error("All preferred models failed. Attempting model discovery...");
  await listAvailableModels();

  throw lastError;
}

// Helper function to fetch weather data for a location (defaulting to Harare)
async function getDailyWeather(lat = -17.824858, lon = 31.053028) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,wind_speed_10m&timezone=auto`;
    // We can use native node fetch (requires Node 18+)
    const response = await fetch(url);
    const data = await response.json();
    return {
      temp: data.current.temperature_2m,
      rain: data.current.precipitation,
      wind: data.current.wind_speed_10m,
    };
  } catch (err) {
    console.error("Error fetching weather:", err);
    return null; // fallback gracefully
  }
}

// ---- Firebase Admin init ----
// Put your service account JSON into an env var (base64) called FIREBASE_SERVICE_ACCOUNT_BASE64
// Example: base64 serviceAccount.json and paste into Render/Railway env vars.
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!serviceAccountBase64) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64 env var");

const serviceAccountJson = JSON.parse(
  Buffer.from(serviceAccountBase64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountJson),
});

const db = admin.firestore();

// ---- Auth middleware: verifies Firebase ID token ----
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.substring(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token", details: String(e) });
  }
}

// ---- Admin check: role stored in Firestore users/{uid}.role == "admin" ----
async function requireAdmin(req, res, next) {
  const uid = req.user.uid;
  const snap = await db.collection("users").doc(uid).get();
  const role = snap.exists ? snap.data().role : null;
  if (role !== "admin") return res.status(403).json({ error: "Not an admin" });
  next();
}

// ---- Helper: Archive advisories older than 3 days ----
async function archiveOldAdvisories() {
  const threeDaysAgo = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  );

  // Filter `createdAt` in Firestore, but handle `isArchived` in memory
  // to prevent "query requires a composite index" errors
  const snapshot = await db.collection("advisories")
    .where("createdAt", "<", threeDaysAgo)
    .get();

  if (snapshot.empty) return 0;

  const batch = db.batch();
  let updatedCount = 0;
  
  snapshot.docs.forEach(doc => {
    // Only update if not already archived
    if (doc.data().isArchived !== true) {
      batch.update(doc.ref, { isArchived: true });
      updatedCount++;
    }
  });

  if (updatedCount > 0) {
    await batch.commit();
  }
  return updatedCount;
}

// ---- POST /advisories/send  (manual advisory) ----
app.post("/advisories/send", requireAuth, requireAdmin, async (req, res) => {
  try {
    const message = (req.body.message || "").trim().slice(0, 2000);
    if (!message) return res.status(400).json({ error: "Message is empty" });

    // Save advisory in Firestore
    await db.collection("advisories").add({
      message,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "manual",
      isArchived: false,
    });

    // Push to all devices subscribed to topic
    await admin.messaging().send({
      topic: "advisories",
      notification: {
        title: "Farming Advisory",
        body: message,
      },
      data: {
        type: "advisory",
      },
      android: {
        notification: {
          channelId: "advisory_channel",
          priority: "high",
        },
      },
    });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.get("/", (_, res) => res.send("MindaPrice ZW Backend is running! 🚀"));

// ---- POST /users/register-location (called by Flutter on login/launch) ----
app.post("/users/register-location", requireAuth, async (req, res) => {
  try {
    const { locationTopic, lat, lon, locationName } = req.body;
    if (!locationTopic || lat == null || lon == null) {
      return res.status(400).json({ error: "Missing locationTopic, lat, or lon" });
    }

    // Upsert into active_regions collection — one doc per region topic
    await db.collection("active_regions").doc(locationTopic).set({
      topic: locationTopic,
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      name: locationName || locationTopic,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json({ success: true });
  } catch (e) {
    console.error("register-location error:", e);
    return res.status(500).json({ error: "Failed to register location", details: String(e) });
  }
});

app.get("/weather/advisory", async (req, res) => {
  try {

    // Pull from query parameters if provided, else default to Harare central
    const latitude = req.query.lat || "-17.8292";   
    const longitude = req.query.lon || "31.0522";

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}` +
      `&longitude=${longitude}` +
      `&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m` +
      `&timezone=auto`;

    const response = await fetch(url);
    const data = await response.json();

    // Use the current hour index so we get live conditions, not midnight's data
    const hourIndex = new Date().getHours();
    const rainProb = data.hourly.precipitation_probability[hourIndex];
    const rainMm = data.hourly.precipitation[hourIndex];
    const wind = data.hourly.wind_speed_10m[hourIndex];
    const temp = data.hourly.temperature_2m[hourIndex];

    let advisory =
      "Weather conditions are stable. Proceed with normal farming activities.";

    if (rainProb >= 70 || rainMm > 3) {
      advisory =
        "High chance of rain. Delay fertilizer application and prepare drainage.";
    }
    else if (wind > 25) {
      advisory =
        "Strong winds expected. Secure light farm materials and avoid spraying.";
    }
    else if (temp > 32) {
      advisory =
        "High temperatures expected. Water crops early and monitor heat stress.";
    }

    res.json({
      weather: {
        temperature: temp,
        precipitation_probability: rainProb,
        precipitation: rainMm,
        wind_speed: wind,
      },
      advisory
    });

  } catch (error) {
    res.status(500).json({ error: "Weather API failed", details: error });
  }
});

// ---- POST /advisories/ai-draft  (generate draft for admin) ----
app.post("/advisories/ai-draft", requireAuth, requireAdmin, aiLimiter, async (req, res) => {
  try {
    const weatherOverride = req.body.weather;
    const location = (req.body.location || "the local area").trim().slice(0, 500);
    const lat = parseFloat(req.body.lat) || null;
    const lon = parseFloat(req.body.lon) || null;

    let weatherText = "";
    if (weatherOverride) {
      weatherText = `Current weather around ${location} is approximately Temp: ${weatherOverride.temp}°C, Rain: ${weatherOverride.rain}mm, Wind: ${weatherOverride.wind}km/h.`;
    } else {
      // Use provided coords if available, else fall back to default
      const liveWeather = await getDailyWeather(lat ?? undefined, lon ?? undefined);
      if (liveWeather) {
        weatherText = `Current weather in ${location} is Temp: ${liveWeather.temp}°C, Rain: ${liveWeather.rain}mm, Wind: ${liveWeather.wind}km/h.`;
      }
    }

    const systemInstruction = `
      You are Minda, a wise and friendly Zimbabwean agricultural mentor. 
      Your task is to draft a concise, professional farming advisory based on the provided weather data.
      Keep it practical and targeted to smallholder farmers. 
      Do not include meta-text like "Here is the draft".
    `;
    const prompt = `Location: ${location}\n${weatherText}\n\nDraft a concise farming advisory.`;

    const result = await callGemini(prompt, [], systemInstruction, true);
    return res.json({ result: result.trim() });
  } catch (error) {
    console.error("Gemini Error:", error);
    return res.status(500).json({ error: "Failed to generate AI advisory.", details: String(error) });
  }
});

// ---- POST /ai/advisor-chat (Minda: Personalized Chat) ----
app.post("/ai/advisor-chat", requireAuth, aiLimiter, async (req, res) => {
  try {
    const { history, farmProfile, location, lat, lon, preferredLanguage, imageBase64, imageMimeType } = req.body;
    const message = (req.body.message || "").trim().slice(0, 2000);
    const lang = preferredLanguage || "English";
    
    if (!message && !imageBase64) return res.status(400).json({ error: "Message or image is required" });

    // Fetch weather context
    let weatherText = "Weather data is currently unavailable.";
    const weather = await getDailyWeather(lat, lon);
    if (weather) {
      weatherText = `The current weather in ${location || "the area"} is: ${weather.temp}°C with ${weather.rain}mm of rainfall and ${weather.wind}km/h winds.`;
    }

    // Prepare system prompt for "Minda"
    const systemInstruction = `
      You are Minda, a wise, friendly, and highly knowledgeable Zimbabwean agricultural mentor. 
      Your goal is to help local farmers succeed by providing practical, science-backed, and traditionally sound advice.
      
      User Profile: ${farmProfile || "The user hasn't described their farm yet. Ask them politely what they are growing."}
      Context: ${weatherText}
      Location: ${location || "Zimbabwe"}
      
      Conversation Rules:
      1. Always stay in character as Minda. Be encouraging, warm, and professional.
      2. Keep responses relatively concise but thorough enough to be helpful (WhatsApp style).
      3. CRITICAL LANGUAGE RULE: The user's preferred language is ${lang}. You MUST translate your entire response and speak fluently in ${lang}. However, if there is no direct translation for a complex agricultural term, you may use the standard English term.
      4. If the weather is dangerous (high heat, heavy rain), prioritize safety warnings.
      5. Never give financial advice outside of agricultural context.
      6. If you don't know something, be honest but suggest where they could find out (e.g. Agritex offices).
      7. If the user sends an image, analyse it carefully and provide agricultural insights about what you see (crop health, disease, pests, soil, etc.).
    `;

    // Build image data payload if present
    const imageData = imageBase64 ? { base64: imageBase64, mimeType: imageMimeType || "image/jpeg" } : null;

    const responseText = await callGemini(message || "Please analyse this image.", history || [], systemInstruction, false, imageData);
    return res.json({ response: responseText });
  } catch (error) {
    console.error("Minda Chat Error:", error);
    return res.status(500).json({ error: "Minda is temporarily resting. Try again in a moment.", details: String(error) });
  }
});

// ---- GET /advisories/trigger-ai  (automated cron webhook) ----
app.get("/advisories/trigger-ai", (req, res) => {
  // Simple Secret Verification so random people cannot trigger the cron job
  const expectedSecret = process.env.CRON_SECRET;
  const providedSecret = req.query.secret || req.headers["x-cron-secret"];

  if (!expectedSecret) {
    return res.status(500).send("Server Error: CRON_SECRET not set in Render environment.");
  }

  if (providedSecret?.trim() !== expectedSecret.trim()) {
    return res.status(403).send(`Unauthorized: Secret mismatch. Provided: ${providedSecret ? "Yes" : "No"}`);
  }

  // Respond immediately to prevent cron-service timeouts
  res.status(202).send("Advisory processing started in background.");

  // Run the heavy operations asynchronously
  (async () => {
    try {
      // Feature 2: Read from lightweight active_regions collection (1 Firestore read)
      // instead of sweeping the entire users collection.
      let activeRegions = {};
      try {
        const regionsSnap = await db.collection("active_regions").get();
        regionsSnap.forEach(doc => {
          const data = doc.data();
          if (data.topic && data.lat && data.lon) {
            activeRegions[data.topic] = {
              topic: data.topic,
              lat: data.lat,
              lon: data.lon,
              name: data.name || data.topic,
            };
          }
        });
      } catch (e) {
        console.error("Error fetching active_regions:", e);
      }

      let provinces = Object.values(activeRegions);

      if (provinces.length === 0) {
        // Fallback: Default to Top 5 Agricultural Provinces in Zimbabwe if no users registered location
        provinces = [
          { name: "Harare Province", lat: -17.8292, lon: 31.0522, topic: "advisories_Harare_Zimbabwe" },
          { name: "Matebeleland Province", lat: -20.1500, lon: 28.5833, topic: "advisories_Bulawayo_Zimbabwe" },
          { name: "Manicaland Province", lat: -18.9728, lon: 32.6694, topic: "advisories_Manicaland_Zimbabwe" },
          { name: "Midlands Province", lat: -19.4500, lon: 29.8167, topic: "advisories_Midlands_Zimbabwe" },
          { name: "Masvingo Province", lat: -20.0833, lon: 30.8333, topic: "advisories_Masvingo_Zimbabwe" },
        ];
      }

      // Feature 1: Process regions with p-limit(3) — max 3 concurrent Gemini calls
      // to stay within the 15 RPM free-tier quota.
      const limit = pLimit(3);
      const regionPromises = provinces.map((p) => limit(async () => {
        try {
          const weather = await getDailyWeather(p.lat, p.lon);
          if (!weather) return;

          // Build the prompt here (was previously undefined, causing ReferenceError)
          const prompt = `Location: ${p.name}\nWeather: Temp ${weather.temp}°C, Rain ${weather.rain}mm, Wind ${weather.wind}km/h.\n\nDraft a concise farming advisory for smallholder farmers.`;
          const advisoryText = await callGemini(prompt, [], "Farming advisor persona.", true);
          const fullMessage = `📍 ${p.name}: ${weather.temp}°C (${weather.rain}mm rain, ${weather.wind}km/h wind)\nAdvisory: ${advisoryText}`;

          // Save to Firestore specific to this topic so history works
          await db.collection("advisories").add({
            message: `[Automated AI Advisory]\n${fullMessage}`,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            isAutomated: true,
            source: "cron-job",
            topic: p.topic,
            isArchived: false,
          });

          // Broadcast FCM Push Notification targeted ONLY to this specific location
          await admin.messaging().send({
            topic: p.topic,
            notification: {
              title: "Daily Farming Advisory 🌾",
              body: fullMessage,
            },
            data: { type: "advisory" },
            android: {
              notification: {
                channelId: "advisory_channel",
                priority: "high",
              },
            },
          });
        } catch (err) {
          console.error(`Failed processing region ${p.name}:`, err);
        }
      }));

      // Wait for all batched regional broadcasts to finish
      await Promise.all(regionPromises);

      // 1.1 Archive old advisories (Housekeeping)
      const archivedCount = await archiveOldAdvisories();
      console.log(`Archived ${archivedCount} old advisories during cron.`);

      console.log("Automated advisory generated and broadcasted successfully for all regions.");
    } catch (error) {
      console.error("CRON ERROR: Automated Trigger Failed:", error);
      console.error("CRON ERROR DETAILS:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
    }
  })();
});
app.post("/messages/notify", requireAuth, async (req, res) => {
  try {
    const { recipientUid, senderUid, senderName, message } = req.body;

    if (!recipientUid || !senderUid || !senderName || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const userDoc = await db.collection("users").doc(recipientUid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Recipient not found" });
    }

    const fcmToken = userDoc.data().fcmToken;

    if (!fcmToken) {
      return res.status(400).json({ error: "Recipient has no FCM token" });
    }

    await admin.messaging().send({
      token: fcmToken,
      notification: {
        title: senderName,
        body: message,
      },
      data: {
        type: "chat",
        senderId: senderUid,
        senderName: senderName,
        message: message,
      },
      android: {
        notification: {
          channelId: "chat_channel",
          priority: "high",
        },
      },
    });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to send chat notification",
      details: String(error),
    });
  }
});

// ---- POST /ratings/notify (Notify user of a new review) ----
app.post("/ratings/notify", requireAuth, async (req, res) => {
  try {
    const { recipientUid, score, senderName } = req.body;

    if (!recipientUid || score == null || !senderName) {
      return res.status(400).json({ error: "Missing recipientUid, score, or senderName" });
    }

    const userDoc = await db.collection("users").doc(recipientUid).get();
    if (!userDoc.exists) return res.status(404).json({ error: "Recipient not found" });

    const data = userDoc.data();
    // OPT-OUT Check: Default to true if not set
    const notificationsEnabled = data.reviewNotificationsEnabled !== false;
    const fcmToken = data.fcmToken;

    if (!notificationsEnabled || !fcmToken) {
      return res.json({ success: true, skipped: true, reason: !fcmToken ? "No FCM" : "Disabled" });
    }

    await admin.messaging().send({
      token: fcmToken,
      notification: {
        title: "New Marketplace Rating! ⭐",
        body: `${senderName} gave you a ${score}/5 rating. Your reputation is growing!`,
      },
      data: {
        type: "rating",
      },
      android: {
        notification: {
          channelId: "chat_channel", // Reuse chat channel for high priority
          priority: "high",
        },
      },
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Rating notify error:", error);
    return res.status(500).json({ error: "Failed to send rating notification" });
  }
});


// ---- GET /advisories/maintenance (manual cleanup trigger) ----
app.get("/advisories/maintenance", async (req, res) => {
  const expectedSecret = process.env.CRON_SECRET;
  const providedSecret = req.query.secret || req.headers["x-cron-secret"];

  if (providedSecret !== expectedSecret) {
    return res.status(403).send("Unauthorized");
  }

  try {
    // 1. Mark old ones as archived
    const count = await archiveOldAdvisories();
    
    // 2. Data Migration: Ensure all others have isArchived: false
    const snapshot = await db.collection("advisories").get();
    const batch = db.batch();
    let migratedCount = 0;
    snapshot.docs.forEach(doc => {
      if (doc.data().isArchived === undefined) {
        batch.update(doc.ref, { isArchived: false });
        migratedCount++;
      }
    });
    if (migratedCount > 0) await batch.commit();

    return res.send(`Successfully archived ${count} advisories and migrated ${migratedCount} others.`);
  } catch (error) {
    console.error("Maintenance Error:", error);
    return res.status(500).send("Error performing maintenance.");
  }
});

// ---- GET /ai/debug (List available models) ----
app.get("/ai/debug", async (req, res) => {
  try {
    // We can use the REST API via fetch or a manual call since listModels isn't 
    // consistently exposed in every SDK version's main class.
    const url = `https://generativelanguage.googleapis.com/v1/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    
    // Return a clean list of supported models
    res.json({
      status: "Running",
      apiVersion: "v1",
      models: data.models ? data.models.map(m => m.name) : "No models found",
      raw: data
    });
  } catch (error) {
    res.status(500).json({ error: "Debug failed", details: String(error) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Minda Backend live on port", port));
