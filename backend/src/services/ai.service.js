// backend/src/services/ai.service.js
import axios from "axios";

export const generateResponse = async (prompt) => {
  try {
    const response = await axios.post("http://localhost:11434/api/generate", {
      model: "llama3",
      prompt: prompt,
      stream: false,
      options: {
        temperature: 0.4  ,   // casi determinista, minimiza "improvisación"
        top_p: 0.9,
        repeat_penalty: 1.1
      }
    });

    return response.data.response;
  } catch (error) {
    console.error(error);
    throw new Error("Error con Ollama");
  }
};