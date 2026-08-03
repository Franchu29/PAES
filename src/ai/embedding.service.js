// embedding.service.js
//
// Nota: vector.service.js ya tiene su propia implementación interna de
// getEmbedding (con reintentos) y NO depende de este archivo. Este
// service solo se mantiene por si algo más en tu app lo importa
// directamente. Si nada más lo usa, puedes borrarlo también.

const OLLAMA_URL = "http://localhost:11434/api/embeddings";
const MODEL = "nomic-embed-text";

/**
 * isQuery=true → prefijo "search_query:" (para preguntas del usuario)
 * isQuery=false → prefijo "search_document:" (para texto que se indexa)
 */
export async function createEmbedding(text, isQuery = false) {
  const prefix = isQuery ? "search_query: " : "search_document: ";
  const prompt = `${prefix}${text}`;

  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt }),
  });

  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status}`);
  }

  const data = await res.json();
  if (!data.embedding) {
    throw new Error("Respuesta de Ollama sin 'embedding'");
  }

  return data.embedding;
}