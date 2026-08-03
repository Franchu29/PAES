// vector.service.js

import fs from "fs";
import path from "path";

const DB_FILE = path.resolve("vector_db.json");
const OLLAMA_URL = "http://localhost:11434/api/embeddings";
const EMBED_MODEL = "nomic-embed-text";
const DEDUP_THRESHOLD = 0.95;
const ABSOLUTE_MIN_SCORE = 0.5; // debajo de esto, no hay contexto relevante real
const TOP_K = 3;

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
 * Normaliza pageNum/pages sin importar qué shape traiga el chunk de
 * origen. Contempla 3 casos:
 *   - chunk del chunking nuevo (splitByPregunta): { pageNum, pages: [1,2] }
 *   - chunk del fallback viejo (splitSmart por página): { pageNum }
 *   - string plano (compat retro, sin metadata de página)
 */
const normalizePageInfo = (rawChunk) => {
  if (typeof rawChunk === "string") {
    return { pageNum: null, pages: [] };
  }
  const pageNum = rawChunk.pageNum ?? null;
  const pages = Array.isArray(rawChunk.pages)
    ? rawChunk.pages.filter((p) => p !== null && p !== undefined)
    : pageNum !== null
    ? [pageNum]
    : [];
  return { pageNum, pages };
};

/**
 * chunks es un array de OBJETOS: { text, pageNum, pages?, preguntaNum?,
 * sectionTitle? } (pages, preguntaNum y sectionTitle son opcionales —
 * preguntaNum viene del chunking por "Pregunta N", sectionTitle viene
 * del chunking por secciones/heading; nunca coexisten en el mismo chunk
 * porque provienen de ramas distintas de la cascada de chunking).
 * docId identifica el documento de origen (ej. nombre del PDF).
 * Guardar pages/docId/preguntaNum/sectionTitle es lo que permite citar
 * la fuente al alumno con precisión, incluso cuando la respuesta está
 * repartida en más de una página del PDF original.
 */
export const addChunksToVectorDB = async (chunks, docId = "unknown") => {
  console.log("📥 Procesando", chunks.length, "chunks de", docId);

  const db = loadDB();

  for (let i = 0; i < chunks.length; i++) {
    try {
      console.log(`🧠 Chunk ${i + 1}/${chunks.length}`);

      const rawChunk = chunks[i];
      const rawText = typeof rawChunk === "string" ? rawChunk : rawChunk.text;
      const { pageNum, pages } = normalizePageInfo(rawChunk);
      const preguntaNum =
        typeof rawChunk === "string" ? null : rawChunk.preguntaNum ?? null;
      const sectionTitle =
        typeof rawChunk === "string" ? null : rawChunk.sectionTitle ?? null;
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
        pageNum,        // compat: primera página del chunk (o null)
        pages,          // array completo de páginas que toca el chunk
        preguntaNum,    // "1", "2", ... si viene del chunking por "Pregunta N"
        sectionTitle,   // título de sección si viene del chunking por secciones
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
 * Formatea la etiqueta de fuente para el contexto inyectado al prompt.
 * Prioriza preguntaNum sobre sectionTitle porque son mutuamente
 * excluyentes (vienen de ramas distintas de la cascada de chunking) —
 * si algún día coexistieran, preguntaNum es la señal más específica.
 */
const formatPageLabel = (item) => {
  const pageLabel =
    item.pages && item.pages.length > 1
      ? `Págs. ${item.pages.join("-")}`
      : item.pages && item.pages.length === 1
      ? `Pág. ${item.pages[0]}`
      : `Pág. ${item.pageNum ?? "?"}`;

  if (item.preguntaNum) return `${pageLabel} — Pregunta ${item.preguntaNum}`;
  if (item.sectionTitle) return `${pageLabel} — ${item.sectionTitle}`;
  return pageLabel;
};

/**
 * Devuelve:
 *   - null                        → no hay contexto suficientemente relevante
 *   - { context, sources }        → context listo para el prompt (con
 *                                    citas de página/sección), sources es
 *                                    la lista de {pageNum, pages, docId,
 *                                    preguntaNum, sectionTitle, score}
 *
 * El código que llama a queryVectorDB debe manejar el caso null
 * (responder "no tengo ese contenido" en vez de alucinar).
 */
export const queryVectorDB = async (query) => {
  console.log("🔎 Buscando...");
  const db = loadDB();
  if (!db.length) return null;

  const queryEmbedding = await getEmbedding(query, true);

  const scored = db.map((item) => ({
    text: item.text,
    pageNum: item.pageNum,
    pages: item.pages || [],
    preguntaNum: item.preguntaNum ?? null,
    sectionTitle: item.sectionTitle ?? null,
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
    results.map((r) => ({
      pageNum: r.pageNum,
      preguntaNum: r.preguntaNum,
      sectionTitle: r.sectionTitle,
      score: r.score.toFixed(3),
    }))
  );

  const context = results
    .map((r) => `[${formatPageLabel(r)}] ${r.text.trim()}`)
    .join("\n\n---\n\n");

  const sources = results.map((r) => ({
    pageNum: r.pageNum,
    pages: r.pages,
    preguntaNum: r.preguntaNum,
    sectionTitle: r.sectionTitle,
    docId: r.docId,
    score: r.score,
  }));

  return { context, sources };
};