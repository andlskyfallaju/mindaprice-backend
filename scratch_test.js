require("dotenv").config();
const admin = require("firebase-admin");

const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!serviceAccountBase64) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64 env var");

const serviceAccountJson = JSON.parse(
  Buffer.from(serviceAccountBase64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountJson),
});

const db = admin.firestore();

async function run() {
  console.log("Fetching products...");
  const snapshot = await db.collection("products").get();
  snapshot.docs.forEach(doc => {
    console.log(`Product: ${doc.id}, SellerId: ${doc.data().sellerId}`);
  });

  console.log("Fetching users...");
  const usersSnapshot = await db.collection("users").get();
  usersSnapshot.docs.forEach(doc => {
    console.log(`User: ${doc.id}, Username: ${doc.data().username}`);
  });
}

run().catch(console.error).finally(() => process.exit(0));
