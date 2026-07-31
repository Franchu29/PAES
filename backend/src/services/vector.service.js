// vector.service.js

import fs from "fs";
import path from "path";

const DB_FILE = path.resolve("vector_db.json");
const OLLAMA_URL = "http://localhost:11434/api/embeddings";
const EMBED_MODEL = "nomic-embed-text";
const DEDUP_THRESHOLD = 0.95;
const ABSOLUTE_MIN_SCORE = 0.5; // debajo de esto, no hay contexto relevante real
const TOP_K = 5;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const loadDB = () => {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const data = fs.readFileSync(DB_FILE, "utf-8");
    return data.trim() ? JSON.parse(data) : [];
  } catch (error) {
    console.error("❌ Error cargando DB:", error.message);
    return [];
  }
};

const saveDB = (data) => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("❌ Error guardando DB:", error.message);
    throw error;
  }
};

/**
 * isQuery=true agrega el prefijo "search_query:", false agrega
 * "search_document:". nomic-embed-text fue entrenado para distinguir
 * estos dos casos — sin el prefijo correcto el retrieval pierde precisión
 * de forma medible, aunque el modelo siga "funcionando" sin errores.
 */
const getEmbedding = async (text, isQuery = false) => {
  const prefix = isQuery ? "search_query: " : "search_document: ";
  const prefixedText = `${prefix}${text}`;

  const MAX_RETRIES = 3;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      console.log(`🧠 Embedding intento ${i}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);

      const res = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: prefixedText }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!res.ok) throw new Error(`Status ${res.status}`);

      const data = await res.json();
      if (!data.embedding) throw new Error("No embedding");
      return data.embedding;
    } catch (err) {
      console.warn(`⚠️ Intento ${i} falló:`, err.message);
      if (i === MAX_RETRIES) throw err;
      await sleep(1000 * i);
    }
  }
};

const cosineSimilarity = (a, b) => {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  if (!magA || !magB) return 0;
  return dot / (magA * magB);
};

/**
 * chunks ahora es un array de OBJETOS, no de strings:
 *   { text: string, pageNum: number }
 * docId identifica el documento de origen (ej. nombre del PDF).
 * Guardar pageNum/docId es lo que permite citar la fuente al alumno
 * y, más adelante, activar revisión visual solo en páginas con tablas.
 * Se mantiene compatibilidad: si pasas un array de strings, sigue
 * funcionando pero sin pageNum (null).
 */
export const addChunksToVectorDB = async (chunks, docId = "unknown") => {
  console.log("📥 Procesando", chunks.length, "chunks de", docId);

  const db = loadDB();

  for (let i = 0; i < chunks.length; i++) {
    try {
      console.log(`🧠 Chunk ${i + 1}/${chunks.length}`);

      const rawChunk = chunks[i];
      const rawText = typeof rawChunk === "string" ? rawChunk : rawChunk.text;
      const pageNum =
        typeof rawChunk === "string" ? null : rawChunk.pageNum ?? null;
      const text = rawText.trim();

      // 1. detectar truncados
      if (
        text.endsWith("...") ||
        text.startsWith("...") ||
        (text.length < 100 && text.endsWith(","))
      ) {
        console.warn("⚠️ Chunk truncado, se omite");
        continue;
      }

      // 2. filtros básicos
      if (text.length < 40) continue;

      const wordCount = text.split(/\s+/).length;
      if (wordCount < 8) continue;

      if (!/[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(text)) continue;
      if (/^p[aá]gina\s*\d+/i.test(text)) continue;
      if (/^\d+$/.test(text)) continue;

      const uniqueWords = new Set(text.split(/\s+/));
      if (uniqueWords.size < wordCount * 0.5) continue;

      // 3. normalización
      const cleanText = text
        .replace(/\s+/g, " ")
        .replace(/\n+/g, " ")
        .trim();

      // 4. embedding (documento → isQuery=false)
      const embedding = await getEmbedding(cleanText, false);

      // 5. deduplicación semántica
      const isDuplicate = db.some(
        (item) => cosineSimilarity(item.embedding, embedding) > DEDUP_THRESHOLD
      );

      if (isDuplicate) {
        console.log("⚠️ Chunk duplicado omitido");
        continue;
      }

      // 6. guardar con metadata
      db.push({
        text: cleanText,
        embedding,
        pageNum,
        docId,
        createdAt: new Date().toISOString(),
      });

      await sleep(300);
    } catch (err) {
      console.error(`❌ Error chunk ${i + 1}, se omite:`, err.message);
    }
  }

  saveDB(db);
  console.log("✅ Guardado total:", db.length);
};

/**
 * CAMBIO DE CONTRATO respecto a la versión anterior:
 * Antes devolvía un string siempre. Ahora devuelve:
 *   - null                        → no hay contexto suficientemente relevante
 *   - { context, sources }        → context listo para el prompt (con
 *                                    citas de página), sources es la lista
 *                                    de {pageNum, docId, score} usada
 *
 * Hay que actualizar el código que llama a queryVectorDB para manejar
 * el caso null (responder "no tengo ese contenido" en vez de alucinar).
 */
export const queryVectorDB = async (query) => {
  console.log("🔎 Buscando...");
  const db = loadDB();
  if (!db.length) return null;

  const queryEmbedding = await getEmbedding(query, true);

  const scored = db.map((item) => ({
    text: item.text,
    pageNum: item.pageNum,
    docId: item.docId,
    score: cosineSimilarity(queryEmbedding, item.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  const bestScore = scored[0]?.score || 0;
  console.log("🏆 Mejor score:", bestScore);

  if (bestScore < ABSOLUTE_MIN_SCORE) {
    console.log("🚫 Nada supera el piso mínimo de relevancia, no hay contexto");
    return null;
  }

  let threshold;
  if (bestScore > 0.8) threshold = 0.7;
  else if (bestScore > 0.7) threshold = 0.65;
  else threshold = 0.6;

  const filtered = scored.filter((r) => r.score > threshold);
  const results = (filtered.length ? filtered : scored.slice(0, 1)).slice(
    0,
    TOP_K
  );

  console.log(
    "📌 Resultados usados:",
    results.map((r) => ({ pageNum: r.pageNum, score: r.score.toFixed(3) }))
  );

  const context = results
    .map((r) => `[Pág. ${r.pageNum ?? "?"}] ${r.text.trim()}`)
    .join("\n\n---\n\n");

  const sources = results.map((r) => ({
    pageNum: r.pageNum,
    docId: r.docId,
    score: r.score,
  }));

  return { context, sources };
};