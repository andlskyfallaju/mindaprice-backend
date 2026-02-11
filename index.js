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
