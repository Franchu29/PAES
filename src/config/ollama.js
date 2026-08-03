import axios from "axios";

const ollama = axios.create({
  baseURL: process.env.OLLAMA_URL,
});

export default ollama;