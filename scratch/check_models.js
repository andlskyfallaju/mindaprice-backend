require("dotenv").config();
const fetch = require("node-fetch");

async function checkModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY not found in .env");
    process.exit(1);
  }

  console.log("Checking available models for current API key...");
  
  const versions = ["v1", "v1beta"];
  for (const v of versions) {
    try {
      const url = `https://generativelanguage.googleapis.com/${v}/models?key=${apiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.models) {
        console.log(`\nModels available in ${v}:`);
        data.models.forEach(m => {
          console.log(`- ${m.name} (supports: ${m.supportedGenerationMethods.join(", ")})`);
        });
      } else {
        console.log(`\nNo models returned for ${v}:`, JSON.stringify(data));
      }
    } catch (e) {
      console.error(`Error checking ${v}:`, e.message);
    }
  }
}

checkModels().catch(console.error);
