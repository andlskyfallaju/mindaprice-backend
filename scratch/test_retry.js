const mockGenAI = {
  getGenerativeModel: (config, options) => {
    console.log(`Mocking model: ${config.model} with apiVersion: ${options.apiVersion}`);
    if (config.model === "gemini-1.5-flash") {
      throw new Error("[GoogleGenerativeAI Error]: Error fetching from https://...: [404 Not Found] models/gemini-1.5-flash is not found");
    }
    return {
      generateContent: async (prompt) => {
        return { response: { text: () => "Mocked Success!" } };
      }
    };
  }
};

async function testRetryLogic() {
  const models = [
    "gemini-1.5-flash", 
    "gemini-1.5-flash-latest", 
    "gemini-2.0-flash", 
    "gemini-1.5-pro"
  ];
  let lastError = null;

  for (const modelName of models) {
    try {
      const model = mockGenAI.getGenerativeModel({ model: modelName }, { apiVersion: "v1beta" });
      const result = await model.generateContent("test prompt");
      console.log(`SUCCESS with model: ${modelName}. Result: ${result.response.text()}`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Model ${modelName} failed correctly in test:`, err.message);
      
      const msg = err.message.toLowerCase();
      if (msg.includes("quota") || msg.includes("429") || msg.includes("404") || msg.includes("403") || msg.includes("not found")) {
        console.log(`Retrying with next model...`);
        continue;
      }
      continue;
    }
  }
  console.error("Test failed: Should have succeeded with gemini-1.5-flash-latest");
}

testRetryLogic().catch(console.error);
