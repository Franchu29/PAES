// train.controller.js

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { addChunksToVectorDB } from "../services/vector.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const normalizeForDedup = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();

const cleanLine = (text) =>
  text.replace(/\s+/g, " ").replace(/•/g, "").trim();

const cleanText = (text) =>
  text
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/•/g, "")
    .trim();

/**
 * Detecta líneas que se repiten idénticas en varias páginas Y que además
 * viven en la franja superior o inferior de la página (zona de header/footer).
 *
 * La restricción de POSICIÓN es la clave: un header editorial real siempre
 * aparece en el mismo lugar físico de cada página. Una frase de contenido
 * que se repite por casualidad (ej. "en diversos contextos." como cierre
 * de bullet, muy común en temarios) puede aparecer en cualquier parte del
 * cuerpo -> sin este filtro de posición, se confundía con un header y se
 * borraba también donde era contenido real, causando texto truncado.
 *
 * edgeZone=0.12 -> solo el 12% superior o 12% inferior de la página
 * cuenta como candidato a header/footer.
 */
function detectRunningLines(rawPageLines, minPageFraction = 0.3, edgeZone = 0.12) {
  const pagesByLine = new Map();
  for (const { pageNum, lines } of rawPageLines) {
    const seenThisPage = new Set();
    const candidateIdxs = new Set([0, lines.length - 1]); // <-- clave del fix
    lines.forEach((line, idx) => {
      if (!candidateIdxs.has(idx)) return;
      const inEdgeZone = line.yRatio >= 1 - edgeZone || line.yRatio <= edgeZone;
      if (!inEdgeZone) return;
      const norm = normalizeForDedup(cleanLine(line.text));
      if (!norm || seenThisPage.has(norm)) return;
      seenThisPage.add(norm);
      if (!pagesByLine.has(norm)) pagesByLine.set(norm, new Set());
      pagesByLine.get(norm).add(pageNum);
    });
  }

  const totalPages = rawPageLines.length;
  const runningLines = new Set();
  for (const [norm, pages] of pagesByLine) {
    if (pages.size >= 3 && pages.size / totalPages >= minPageFraction) {
      runningLines.add(norm);
    }
  }
  return runningLines;
}

/**
 * Detecta un "gutter" real de 2 columnas editoriales: una franja
 * vertical angosta CASI SIN texto, consistente a lo largo de gran
 * parte del ancho, con contenido sustancial a ambos lados.
 *
 * Esto es distinto a una tabla embebida en una página de 1 columna:
 * una tabla normalmente SÍ tiene contenido cerca del centro de la
 * página (columnas intermedias), así que no dispara este heurístico.
 * Devuelve el punto de split si detecta 2 columnas reales, o null.
 */
function detectColumnGutter(items, pageWidth, bandFraction = 0.08) {
  const mid = pageWidth / 2;
  const bandHalfWidth = pageWidth * bandFraction;

  const inBand = items.filter(
    (it) => it.x > mid - bandHalfWidth && it.x < mid + bandHalfWidth
  );
  const left = items.filter((it) => it.x <= mid - bandHalfWidth);
  const right = items.filter((it) => it.x >= mid + bandHalfWidth);

  const bandRatio = inBand.length / items.length;
  const leftRatio = left.length / items.length;
  const rightRatio = right.length / items.length;

  const looksLikeTwoColumns =
    bandRatio < 0.03 && leftRatio > 0.25 && rightRatio > 0.25;

  return looksLikeTwoColumns ? mid : null;
}

/**
 * Agrupa items en filas por coordenada Y (con tolerancia) y ordena
 * cada fila por X. El threshold para decidir "esto es columna de tabla,
 * no texto corrido" es RELATIVO al fontSize real de esa fila (no un
 * número fijo en puntos) -> un título en 24pt y un cuerpo en 10pt cada
 * uno calibra su propio umbral, sin ramas especiales por tipo de texto.
 *
 * Devuelve un array de líneas con fontSize y yRatio (posición vertical
 * normalizada 0-1 respecto a la altura de página) -> yRatio es lo que
 * usa detectRunningLines para distinguir headers reales de contenido
 * repetido por casualidad.
 *
 * glueFontRatio controla el tercer nivel del heurístico de espaciado:
 * cuando el gap entre dos items es MENOR a avgFontSize * glueFontRatio,
 * se asume que es el mismo "carácter visual" partido en dos items por
 * pdf.js (kerning/hinting, típico en negritas o letras acentuadas) y
 * se pegan SIN espacio. Debe ser claramente menor que el ancho de un
 * espacio real (~0.25-0.3 * fontSize en la mayoría de fuentes) para no
 * comerse espacios legítimos entre palabras. 0.15 es un default
 * conservador para texto en español (las tildes generan más separación
 * de glifos de lo normal) — valídalo empíricamente contra chunks reales
 * antes de darlo por bueno.
 *
 * LIMITACIÓN CONOCIDA: si una celda de tabla envuelve en más de una
 * línea, esas líneas caen en filas Y distintas y pueden desalinearse
 * con la fila siguiente/anterior. Afecta solo a celdas con texto largo
 * que envuelve. Si es recurrente, la solución robusta es reconstrucción
 * de tabla por clustering de columnas, o ruta de visión para esas páginas.
 */
function buildLines(
  items,
  pageHeight,
  yTolerance = 2,
  columnGapCharMultiplier = 4,
  glueFontRatio = 0.15
) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];

  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= yTolerance);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }

  return rows.map((r) => {
    const cells = [...r.items].sort((a, b) => a.x - b.x);

    const sizes = cells.map((c) => c.fontSize).filter((s) => s > 0);
    const avgFontSize =
      sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 10;

    const columnGapThreshold = avgFontSize * columnGapCharMultiplier;
    const glueThreshold = avgFontSize * glueFontRatio;

    let text = cells[0].str;
    for (let i = 1; i < cells.length; i++) {
      const prevEnd = cells[i - 1].x + cells[i - 1].w;
      const gap = cells[i].x - prevEnd;
      if (gap > columnGapThreshold) text += ` | ${cells[i].str}`;
      else if (gap > glueThreshold) text += ` ${cells[i].str}`;
      else text += cells[i].str; // <-- glue sin espacio
    }

    const yRatio = pageHeight > 0 ? r.y / pageHeight : 0.5;

    return { text, fontSize: avgFontSize, yRatio };
  });
}

/**
 * Reconstruye las líneas de una página. Solo divide en 2 columnas si
 * detectColumnGutter confirma un gutter real (layout editorial tipo
 * comprensión lectora). Si no, procesa la página como stream único
 * en orden de lectura natural.
 *
 * Extrae fontSize real de cada item vía transform (hypot de las
 * componentes de escala del matrix) -> dato real del PDF, no un proxy
 * estimado por ancho de glifo.
 *
 * Devuelve un array de líneas ({ text, fontSize, yRatio }).
 */
function extractTextFromPage(content, pageWidth, pageHeight) {
  const items = content.items
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      fontSize: Math.hypot(it.transform[0], it.transform[1]),
    }))
    .filter((it) => it.str.trim().length > 0);

  if (items.length === 0) return [];

  const gutter = detectColumnGutter(items, pageWidth);
  if (!gutter) return buildLines(items, pageHeight);

  const left = items.filter((it) => it.x < gutter);
  const right = items.filter((it) => it.x >= gutter);
  return [...buildLines(left, pageHeight), ...buildLines(right, pageHeight)];
}

/**
 * Chunking por tamaño fijo. Último escalón de la cascada (Intento 3):
 * solo se usa si el documento no matchea ni el patrón "Pregunta N"
 * ni el patrón de secciones por heading.
 */
function splitSmart(text, chunkSize = 900, overlap = 100) {
  const chunks = [];
  const paragraphs = text.split(/\n\s*\n/);
  let currentChunk = "";

  for (const p of paragraphs) {
    const paragraph = p.trim();
    if (!paragraph) continue;

    if ((currentChunk + paragraph).length <= chunkSize) {
      currentChunk += paragraph + "\n\n";
    } else {
      if (currentChunk) chunks.push(currentChunk.trim());

      if (paragraph.length > chunkSize) {
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        let temp = "";
        for (const s of sentences) {
          if ((temp + s).length <= chunkSize) {
            temp += s + " ";
          } else {
            chunks.push(temp.trim());
            temp = s + " ";
          }
        }
        if (temp) chunks.push(temp.trim());
        currentChunk = "";
      } else {
        currentChunk = paragraph + "\n\n";
      }
    }
  }

  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
}

/**
 * Concatena el texto (plano, ya limpiado) de todas las páginas en un
 * solo string y guarda un mapa de offsets (start/end de cada página).
 * Permite chunkear sobre el documento entero sin perder la frontera
 * "página N termina, página N+1 empieza", y mapear cualquier rango de
 * caracteres del chunk resultante a la(s) página(s) de origen.
 */
function buildFullTextWithPageMap(pageTexts) {
  let fullText = "";
  const pageMap = []; // { pageNum, start, end }

  for (const { pageNum, text } of pageTexts) {
    const start = fullText.length;
    fullText += text + "\n\n";
    const end = fullText.length;
    pageMap.push({ pageNum, start, end });
  }

  return { fullText, pageMap };
}

/** Devuelve todas las páginas cuyo rango [start,end) se solapa con [rangeStart,rangeEnd). */
function pagesForRange(pageMap, rangeStart, rangeEnd) {
  const pages = pageMap
    .filter((p) => p.start < rangeEnd && p.end > rangeStart)
    .map((p) => p.pageNum);
  return pages.length ? pages : [null];
}

/**
 * Chunking ESTRUCTURAL (Intento 1): la unidad atómica es el bloque
 * completo de "Pregunta N" (ENUNCIADO + ALTERNATIVAS + CLAVE +
 * RESOLUCIÓN + CREADOR), sin importar cuántas páginas ocupe.
 *
 * Devuelve null si el documento no matchea el patrón (permite pasar
 * al siguiente escalón de la cascada).
 */
function splitByPregunta(fullText, pageMap) {
  const regex = /Pregunta\s+\d+\s*\n?\s*ENUNCIADO/g;
  const matches = [...fullText.matchAll(regex)];
  if (matches.length === 0) return null;

  const chunks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : fullText.length;
    const text = fullText.slice(start, end).trim();

    const preguntaNumMatch = text.match(/Pregunta\s+(\d+)/);
    const pages = pagesForRange(pageMap, start, end);

    chunks.push({
      text,
      pageNum: pages[0],
      pages,
      preguntaNum: preguntaNumMatch ? preguntaNumMatch[1] : null,
    });
  }
  return chunks;
}

/** ¿Esta línea es mayormente mayúsculas? (señal de título, no de contenido normal) */
function isUppercaseHeavy(text, minLetters = 3) {
  const letters = text.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ]/g, "");
  if (letters.length < minLetters) return false;
  const upper = letters.replace(/[^A-ZÁÉÍÓÚÑ]/g, "");
  return upper.length / letters.length > 0.8;
}

/**
 * Concatena el documento a nivel de LÍNEA (no colapsa \n a espacio,
 * porque necesitamos el offset de inicio de cada línea individual
 * para poder ubicar los headings dentro del texto completo).
 */
function buildLineLevelDoc(pageTexts) {
  let fullText = "";
  const pageMap = [];
  const lineRecords = [];

  for (const { pageNum, lines } of pageTexts) {
    const pageStart = fullText.length;
    for (const line of lines) {
      const text = cleanLine(line.text);
      if (!text) continue;
      const start = fullText.length;
      fullText += text + "\n";
      lineRecords.push({ start, pageNum, fontSize: line.fontSize, text });
    }
    pageMap.push({ pageNum, start: pageStart, end: fullText.length });
  }
  return { fullText, pageMap, lineRecords };
}

/** El tamaño de fuente "típico" del documento = el que más caracteres acumula. */
function computeBodyFontSize(lineRecords) {
  const weightBySize = new Map();
  for (const l of lineRecords) {
    const key = Math.round(l.fontSize);
    weightBySize.set(key, (weightBySize.get(key) || 0) + l.text.length);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, weight] of weightBySize) {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = size;
    }
  }
  return best;
}

/**
 * Chunking por SECCIONES (Intento 2): corta el documento en cada línea
 * detectada como título (fontSize notablemente mayor al cuerpo +
 * mayúsculas). Pensado para documentos sin patrón "Pregunta N", como
 * temarios. Genérico: no depende de qué dice el heading, solo de cómo
 * se ve tipográficamente.
 *
 * Agrupa líneas heading CONSECUTIVAS (título que envuelve en 2+ líneas,
 * ej. "COMPETENCIA" + "MATEMÁTICA 1 (M1)") en un solo heading, en vez
 * de tratarlas como secciones separadas.
 *
 * Devuelve null si no encuentra ningún heading (pasa al fallback por tamaño).
 */
function splitBySection(pageTexts, jumpRatio = 1.15) {
  const { fullText, pageMap, lineRecords } = buildLineLevelDoc(pageTexts);
  const bodyFontSize = computeBodyFontSize(lineRecords);

  const isHeadingLine = (l) =>
    l.fontSize > bodyFontSize * jumpRatio && isUppercaseHeavy(l.text);

  const headings = [];
  for (let i = 0; i < lineRecords.length; i++) {
    if (!isHeadingLine(lineRecords[i])) continue;
    const group = [lineRecords[i]];
    let j = i + 1;
    while (j < lineRecords.length && isHeadingLine(lineRecords[j])) {
      group.push(lineRecords[j]);
      j++;
    }
    headings.push({ start: group[0].start, text: group.map((g) => g.text).join(" ") });
    i = j - 1;
  }

  console.log(`📐 bodyFontSize: ${bodyFontSize}, headings: ${headings.length}`);
  if (headings.length === 0) return null;

  const chunks = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].start;
    const end = i + 1 < headings.length ? headings[i + 1].start : fullText.length;
    const text = fullText.slice(start, end).trim();
    if (!text) continue;
    const pages = pagesForRange(pageMap, start, end);
    chunks.push({ text, pageNum: pages[0], pages, sectionTitle: headings[i].text });
  }
  return chunks;
}

export const train = async (req, res) => {
  try {
    const filePath = req.file.path;
    const docId = req.file.originalname || path.basename(filePath);

    console.log("📄 Leyendo PDF:", docId);

    const data = new Uint8Array(fs.readFileSync(filePath));

    const pdfDoc = await pdfjsLib.getDocument({
      data,
      standardFontDataUrl: path.join(
        __dirname,
        "../../node_modules/pdfjs-dist/standard_fonts/"
      ),
    }).promise;

    // 1) Extraer líneas crudas (con fontSize y yRatio) de cada página.
    const rawPageLines = [];

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      console.log(`📖 Página ${i}/${pdfDoc.numPages}`);

      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const lines = extractTextFromPage(content, viewport.width, viewport.height);
      if (lines.length) rawPageLines.push({ pageNum: i, lines });
    }

    // 2) Detectar headers/footers recurrentes (deben repetirse Y vivir
    //    en la franja superior/inferior de la página) + números de
    //    página sueltos, y removerlos ANTES de construir el texto por
    //    página -> así el filtro beneficia tanto a splitByPregunta como
    //    a splitBySection sin duplicar lógica.
    const runningLines = detectRunningLines(rawPageLines);
    console.log(
      `🧹 ${runningLines.size} línea(s) recurrente(s) detectada(s) y removida(s) (headers/footers)`
    );

    const pageTexts = rawPageLines
      .map(({ pageNum, lines }) => {
        const filtered = lines.filter((l) => {
          const t = cleanLine(l.text);
          if (!t) return false;
          if (/^\d{1,4}$/.test(t)) return false; // número de página suelto
          if (runningLines.has(normalizeForDedup(t))) return false;
          return true;
        });
        const plainText = cleanText(filtered.map((l) => l.text).join("\n"));
        return { pageNum, lines: filtered, plainText };
      })
      .filter((p) => p.plainText);

    // 3) Concatenar todo el documento (texto plano) y mapear offsets
    //    de página, para no perder trazabilidad.
    const { fullText, pageMap } = buildFullTextWithPageMap(
      pageTexts.map((p) => ({ pageNum: p.pageNum, text: p.plainText }))
    );

    // 4) Cascada de chunking estructural:
    //    Intento 1: patrón "Pregunta N" (pruebas PAES)
    //    Intento 2: secciones por heading (temarios, docs sin preguntas)
    //    Intento 3: fallback ciego por tamaño fijo
    let pageChunks = splitByPregunta(fullText, pageMap);

    if (!pageChunks) {
      console.log(
        "⚠️ No se detectó estructura 'Pregunta N', probando chunking por secciones"
      );
      pageChunks = splitBySection(pageTexts);
    }

    if (!pageChunks) {
      console.log(
        "⚠️ No se detectaron secciones, usando chunking por tamaño (fallback)"
      );
      pageChunks = [];
      for (const { pageNum, plainText } of pageTexts) {
        splitSmart(plainText, 500, 100).forEach((chunkText) =>
          pageChunks.push({ text: chunkText, pageNum, pages: [pageNum] })
        );
      }
    }

    console.log(`📊 ${pageChunks.length} chunks generados`);
    pageChunks.forEach((c, idx) =>
      console.log(
        `--- CHUNK ${idx} (pág. ${(c.pages || [c.pageNum]).join(",")}${
          c.preguntaNum ? `, Pregunta ${c.preguntaNum}` : ""
        }${c.sectionTitle ? `, Sección: ${c.sectionTitle}` : ""}, ${c.text.length} chars) ---\n${c.text}\n`
      )
    );

    if (pageChunks.length === 0) {
      return res.status(400).json({
        error: "No se pudo generar chunks del PDF",
      });
    }

    await addChunksToVectorDB(pageChunks, docId);

    console.log("✅ Entrenamiento completado");

    res.json({
      message: "PDF entrenado correctamente",
      chunks: pageChunks.length,
    });
  } catch (error) {
    console.error("🔥 Error general:", error);
    res.status(500).json({ error: error.message });
  }
};