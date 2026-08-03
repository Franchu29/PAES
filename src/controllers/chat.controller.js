import { generateResponse } from "../services/ai.service.js";
import { queryVectorDB } from "../services/vector.service.js";

export const chat = async (req, res) => {
  try {
    const { message } = req.body;
    console.log("MESSAGE:", message);

    const result = await queryVectorDB(message);

    // Si no hay contexto relevante, respondemos directo sin llamar al LLM:
    // ahorra una inferencia completa de llama3 y evita el riesgo de que
    // el modelo "rellene" con algo aunque el prompt se lo prohíba.
    if (!result) {
      return res.json({
        response: "No se encuentra en el documento.",
        sources: [],
      });
    }

    const { context, sources } = result;

    const prompt = `
    Eres un profesor experto en PAES.

    Reglas estrictas:
    1. Responde utilizando la información que aparece EXPLÍCITAMENTE en el contexto.
    2. NO realices cálculos, sumas ni combinaciones de datos que no estén ya combinados textualmente en el contexto.
    3. Si la pregunta pide un dato que requiere sumar, inferir o combinar varias cifras del contexto, indica cada cifra por separado tal como aparece, pero NO entregues un total calculado por ti si el documento no lo entrega explícitamente.
    4. Si la respuesta NO está explícitamente en el contexto, responde exactamente: "No se encuentra en el documento".
    5. No inventes información ni completes con conocimiento externo bajo ninguna circunstancia.
    6. Si la información aparece aunque sea en formato de tabla o lista, extráela explícitamente.
    7. FORMATO DE RESPUESTA OBLIGATORIO: primero indica la alternativa correcta, luego desarrolla el fundamento completo citando o parafraseando la sección RESOLUCIÓN del contexto. Si el contexto explica por qué las otras alternativas son incorrectas, inclúyelo también. No entregues solo la alternativa sin explicación.

    Contexto:
    ${context}

    Pregunta: ${message}
    `;

    console.log("PROMPT:", prompt);

    const response = await generateResponse(prompt);

    // sources queda disponible para que el frontend muestre
    // "Fuente: PAES_Contexto.pdf, pág. 2" junto a la respuesta.
    res.json({ response, sources });
  } catch (error) {
    console.error("🔥 Error en chat:", error);
    res.status(500).json({ error: error.message });
  }
};