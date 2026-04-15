try {
  const pLimit = require("p-limit");
  console.log("p-limit required, type:", typeof pLimit);
  console.log("p-limit keys:", Object.keys(pLimit));
  if (typeof pLimit === "function") {
    const limit = pLimit(1);
    console.log("p-limit instance created");
  } else if (pLimit.default && typeof pLimit.default === "function") {
    const limit = pLimit.default(1);
    console.log("p-limit.default instance created");
  }
} catch (e) {
  console.error("p-limit require failed:", e.message);
}
