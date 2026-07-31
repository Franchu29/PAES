// train.controller.js

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { addChunksToVectorDB } from "../services/vector.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * Reconstruye las líneas de una página. Solo divide en 2 columnas si
 * detectColumnGutter confirma un gutter real (layout editorial tipo
 * comprensión lectora). Si no, procesa la página como stream único
 * en orden de lectura natural — esto es lo que evita que una tabla
 * de varias columnas pierda su columna más a la derecha (como pasaba
 * con "Duración" antes de este fix).
 */
function extractTextFromPage(content, pageWidth) {
  const items = content.items
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
    }))
    .filter((it) => it.str.trim().length > 0);

  if (items.length === 0) return "";

  const gutter = detectColumnGutter(items, pageWidth);
  if (!gutter) return buildLines(items);

  const left = items.filter((it) => it.x < gutter);
  const right = items.filter((it) => it.x >= gutter);
  return `${buildLines(left)}\n\n${buildLines(right)}`;
}

/**
 * Agrupa items en filas por coordenada Y (con tolerancia) y ordena
 * cada fila por X. Cuando el gap horizontal entre dos items consecutivos
 * de una misma fila es grande (mayor a columnGapThreshold), se inserta
 * un separador " | " en vez de un simple espacio — esto reconstruye
 * filas de tabla como celdas delimitadas explícitamente, en vez de
 * texto corrido indistinguible de una oración normal.
 *
 * LIMITACIÓN CONOCIDA: si una celda de tabla envuelve en más de una
 * línea (ej. "Historia y Ciencias Sociales" partido en 2 líneas dentro
 * de la celda), esas líneas caen en filas Y distintas y pueden alinearse
 * con la fila siguiente/anterior de la tabla, causando un desorden
 * puntual. Afecta solo a celdas con texto largo que envuelve; no afecta
 * columnas de valores cortos como preguntas/duración. Si esto resulta
 * un problema recurrente en tus PDFs, la solución robusta es
 * reconstrucción de tabla por clustering de columnas (no por fila),
 * o activar la ruta de visión (moondream/API) para esas páginas.
 */
function buildLines(items, yTolerance = 2, columnGapThreshold = 20) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];

  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= yTolerance);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }

  return rows
    .map((r) => {
      const cells = [...r.items].sort((a, b) => a.x - b.x);
      let line = cells[0].str;
      for (let i = 1; i < cells.length; i++) {
        const prevEnd = cells[i - 1].x + cells[i - 1].w;
        const gap = cells[i].x - prevEnd;
        line += gap > columnGapThreshold ? ` | ${cells[i].str}` : ` ${cells[i].str}`;
      }
      return line;
    })
    .join("\n");
}

const cleanText = (text) =>
  text
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/•/g, "")
    .trim();

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

    // Chunks con metadata de página. Antes se concatenaba el texto de
    // TODAS las páginas y luego se chunkeaba sobre el string completo,
    // lo que perdía la frontera de página antes de llegar a la DB.
    // Ahora se chunkea página por página y se conserva pageNum.
    const pageChunks = [];

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      console.log(`📖 Página ${i}/${pdfDoc.numPages}`);

      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const rawPageText = extractTextFromPage(content, viewport.width);
      const pageText = cleanText(rawPageText);

      if (!pageText) continue;

      const chunksOfPage = splitSmart(pageText, 500, 100);
      chunksOfPage.forEach((text) => pageChunks.push({ text, pageNum: i }));
    }

    console.log(`📊 ${pageChunks.length} chunks generados`);
    pageChunks.forEach((c, idx) =>
      console.log(
        `--- CHUNK ${idx} (pág. ${c.pageNum}, ${c.text.length} chars) ---\n${c.text}\n`
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