require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());

// Initialize Gemini with the API Key from environment variables
// Note: You must set this in your Render dashboard environment variables
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper to try multiple models in case of regional quota (limit:0) errors
// imageData: optional { mimeType: string, base64: string }
async function callGemini(message, history = [], systemPrompt = "", isDraft = false, imageData = null) {
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite"];
  let lastError = null;

  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName }, { apiVersion: "v1" });
      
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
      // If it's not a quota error, stop and throw
      if (!err.message.includes("quota") && !err.message.includes("429")) throw err;
    }
  }
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
    const message = (req.body.message || "").trim();
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

    const rainProb = data.hourly.precipitation_probability[0];
    const rainMm = data.hourly.precipitation[0];
    const wind = data.hourly.wind_speed_10m[0];
    const temp = data.hourly.temperature_2m[0];

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
app.post("/advisories/ai-draft", requireAuth, async (req, res) => {
  try {
    const weatherOverride = req.body.weather;
    const location = (req.body.location || "the local area").trim();
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

    const result = await callGemini(prompt, [], systemInstruction, true);
    return res.json({ result: result.trim() });
  } catch (error) {
    console.error("Gemini Error:", error);
    return res.status(500).json({ error: "Failed to generate AI advisory.", details: String(error) });
  }
});

// ---- POST /ai/advisor-chat (Minda: Personalized Chat) ----
app.post("/ai/advisor-chat", requireAuth, async (req, res) => {
  try {
    const { message, history, farmProfile, location, lat, lon, imageBase64, imageMimeType } = req.body;
    
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
      3. Use Shona or Ndebele phrases occasionally (like "Zvakanaka" or "Salibonani") to stay relatable, but keep the main advice in English.
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
      // Find active regions from Firestore users
      let activeRegions = {};
      try {
        const usersSnap = await db.collection("users").get();
        usersSnap.forEach(doc => {
          const data = doc.data();
          if (data.locationTopic && data.lat && data.lon) {
            if (!activeRegions[data.locationTopic]) {
              activeRegions[data.locationTopic] = {
                topic: data.locationTopic,
                lat: data.lat,
                lon: data.lon,
                name: data.locationName || data.locationTopic
              };
            }
          }
        });
      } catch (e) {
        console.error("Error fetching regions from users:", e);
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

      // Process each region entirely in parallel: Fetch weather -> Ping Gemini -> Save to DB -> Push Notification
      const regionPromises = provinces.map(async (p) => {
        try {
          const weather = await getDailyWeather(p.lat, p.lon);
          if (!weather) return;

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
              title: "Daily Farming Advisory \u{1F33E}", // Wheat emoji
              body: fullMessage,
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
        } catch (err) {
          console.error(`Failed processing region ${p.name}:`, err);
        }
      });

      // Wait for all regional broadcasts to finish
      await Promise.all(regionPromises);

      // 1.1 Archive old advisories (Housekeeping)
      const archivedCount = await archiveOldAdvisories();
      console.log(`Archived ${archivedCount} old advisories during cron.`);

      console.log("Automated advisory generated and broadcasted successfully for all regions.");
    } catch (error) {
      console.error("Automated Trigger Error:", error);
    }
  })();
});
app.post("/messages/notify", async (req, res) => {
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
          channelId: "advisory_channel",
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
