const pLimitImport = require("p-limit");
const pLimit = pLimitImport.default || pLimitImport;

try {
  console.log("Testing pLimit instance creation...");
  const limit = pLimit(3);
  console.log("Success: pLimit(3) worked.");

  const task = async (i) => {
    console.log(`Task ${i} starting`);
    return new Promise(resolve => setTimeout(() => {
      console.log(`Task ${i} finished`);
      resolve(i);
    }, 100));
  };

  Promise.all([
    limit(() => task(1)),
    limit(() => task(2)),
    limit(() => task(3)),
    limit(() => task(4))
  ]).then(results => {
    console.log("All tasks completed:", results);
    process.exit(0);
  }).catch(err => {
    console.error("Task execution failed:", err);
    process.exit(1);
  });

} catch (e) {
  console.error("pLimit test failed:", e.message);
  process.exit(1);
}
