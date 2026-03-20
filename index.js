require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.json());

// Initialize Gemini with the API Key from environment variables
// Note: You must set this in your Render dashboard environment variables
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

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

  const snapshot = await db.collection("advisories")
    .where("createdAt", "<", threeDaysAgo)
    .where("isArchived", "!=", true)
    .get();

  if (snapshot.empty) return 0;

  const batch = db.batch();
  snapshot.docs.forEach(doc => {
    batch.update(doc.ref, { isArchived: true });
  });

  await batch.commit();
  return snapshot.size;
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

// ---- GET /health ----
app.get("/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Server running on port", port));

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

    const prompt = `
      You are an expert agricultural advisor for MindaPrice ZW, a smart farming app.
      Generate a short, actionable, and encouraging farming advisory broadcast (max 2-3 sentences based on WhatsApp style).
      The user is located in: ${location}.
      ${weatherText}
      Focus on practical advice based on this weather (e.g., watering schedules, pest warnings, storage advice).
      Do NOT include greetings or sign-offs. Just the advisory content.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    return res.json({ result: response.text.trim() });
  } catch (error) {
    console.error("Gemini Error:", error);
    return res.status(500).json({ error: "Failed to generate AI advisory.", details: String(error) });
  }
});

// ---- GET /advisories/trigger-ai  (automated cron webhook) ----
app.get("/advisories/trigger-ai", async (req, res) => {
  // Simple Secret Verification so random people cannot trigger the cron job
  const expectedSecret = process.env.CRON_SECRET;
  const providedSecret = req.query.secret || req.headers["x-cron-secret"];

  if (providedSecret !== expectedSecret) {
    return res.status(403).send("Unauthorized");
  }

  try {
    // Regions: read from CRON_REGIONS env var (JSON array of {name,lat,lon}) or fall back to Zimbabwe defaults
    let provinces;
    try {
      provinces = process.env.CRON_REGIONS
        ? JSON.parse(process.env.CRON_REGIONS)
        : null;
    } catch (_) {
      provinces = null;
    }

    if (!provinces || provinces.length === 0) {
      // Default: Top 5 Agricultural Provinces in Zimbabwe
      provinces = [
        { name: "Harare Province", lat: -17.8292, lon: 31.0522 },
        { name: "Matebeleland Province", lat: -20.1500, lon: 28.5833 },
        { name: "Manicaland Province", lat: -18.9728, lon: 32.6694 },
        { name: "Midlands Province", lat: -19.4500, lon: 29.8167 },
        { name: "Masvingo Province", lat: -20.0833, lon: 30.8333 },
      ];
    }

    let combinedWeatherContext = "";

    // Fetch weather for all regions
    for (const p of provinces) {
      const weather = await getDailyWeather(p.lat, p.lon);
      if (weather) {
        combinedWeatherContext += `${p.name}: Temp: ${weather.temp}°C, Precipitation: ${weather.rain}mm, Wind speed: ${weather.wind}km/h.\n`;
      }
    }

    if (!combinedWeatherContext) {
      return res.status(500).send("Failed to fetch weather data for any region.");
    }

    const regionNames = provinces.map(p => p.name).join(", ");

    const prompt = `
      You are an expert agricultural advisor for MindaPrice ZW, a smart farming app.
      Generate a daily farming advisory broadcast covering these regions: ${regionNames}.
      Keep it extremely concise and actionable.

      Here is the current weather data for today:
      ${combinedWeatherContext}

      Format the output exactly like this (use emojis where appropriate, no introduction or conclusion paragraphs):

      📍 [Region Name]: [Temp]°C ([Rain]mm rain, [Wind]km/h wind)
      Advisory: [1-2 sentences of specific farming advice based on this exact weather pattern]

      (Repeat for each region provided)
    `;

    const generatedResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    const generatedMessage = generatedResponse.text.trim();

    // 1. Save to Firestore
    await db.collection("advisories").add({
      message: `[Automated AI Advisory]\n${generatedMessage}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      isAutomated: true,
      source: "cron-job",
      isArchived: false,
    });

    // 1.1 Archive old advisories (Housekeeping)
    const archivedCount = await archiveOldAdvisories();
    console.log(`Archived ${archivedCount} old advisories during cron.`);

    // 2. Broadcast FCM Push Notification
    await admin.messaging().send({
      topic: "advisories",
      notification: {
        title: "Daily Farming Advisory \u{1F33E}", // Wheat emoji
        body: generatedMessage,
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

    return res.status(200).send("Automated advisory generated and broadcasted successfully.");
  } catch (error) {
    console.error("Automated Trigger Error:", error);
    return res.status(500).send("Error generating automated advisory.");
  }
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
