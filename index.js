require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

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
    });

    // Push to all devices subscribed to topic
    await admin.messaging().send({
      topic: "advisories",
      notification: {
        title: "Farming Advisory",
        body: message,
      },
      data: { type: "advisory" },
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

    const latitude = "-17.8292";   // Harare default
    const longitude = "31.0522";

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
app.post("/messages/notify", async (req, res) => {
  try {
    const { recipientUid, senderName, message } = req.body;

    if (!recipientUid || !senderName || !message) {
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
        senderName,
        message,
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
