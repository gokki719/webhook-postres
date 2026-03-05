const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// ── Configuración ─────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ══════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL: llamar a Gemini para extraer datos
// ══════════════════════════════════════════════════════════
async function extraerConIA(tipo, texto) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const prompts = {
    nombre: `Eres un asistente de una pastelería. El cliente acaba de escribir su nombre para un pedido.
Extrae SOLO el nombre de la persona del siguiente texto. 
Si hay prefijos como "me llamo", "soy", "a nombre de", "mi nombre es", quítalos.
Devuelve SOLO el nombre, sin puntos ni explicaciones.
Texto: "${texto}"
Nombre:`,

    direccion: `Eres un asistente de una pastelería. El cliente acaba de escribir su dirección de entrega.
Limpia y formatea la siguiente dirección para que sea legible.
Si el texto claramente no es una dirección (como insultos o texto sin sentido), devuelve el texto tal cual.
Devuelve SOLO la dirección formateada, sin explicaciones.
Texto: "${texto}"
Dirección:`
  };

  try {
    const result = await model.generateContent(prompts[tipo]);
    return result.response.text().trim();
  } catch (err) {
    console.error('Error Gemini:', err.message);
    return texto; // Si falla Gemini, usar el texto original
  }
}

// ══════════════════════════════════════════════════════════
// WEBHOOK PRINCIPAL
// ══════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  const intentName = req.body.queryResult?.intent?.displayName || '';
  const queryText = req.body.queryResult?.queryText || '';
  const params = req.body.queryResult?.parameters || {};
  const outputContexts = req.body.queryResult?.outputContexts || [];

  console.log(`Intent: ${intentName} | Query: "${queryText}"`);

  // ── pedir_nombre ─────────────────────────────────────────
  if (intentName === 'pedir_nombre') {
    // Gemini extrae el nombre limpio
    const nombreLimpio = await extraerConIA('nombre', queryText);
    
    return res.json({
      fulfillmentText: `¡Gracias, ${nombreLimpio}! 😊\n\n📍 ¿A qué dirección te lo mandamos?\n(Escribe tu calle, número y colonia)`,
      outputContexts: [
        {
          name: `${req.body.session}/contexts/esperando_nombre`,
          lifespanCount: 0
        },
        {
          name: `${req.body.session}/contexts/esperando_direccion`,
          lifespanCount: 5,
          parameters: { nombre: nombreLimpio }
        },
        {
          name: `${req.body.session}/contexts/pedido_en_proceso`,
          lifespanCount: 10,
          parameters: { nombre: nombreLimpio }
        }
      ]
    });
  }

  // ── pedir_direccion ───────────────────────────────────────
  if (intentName === 'pedir_direccion' || intentName === 'captura_direccion_fallback') {
    // Obtener nombre del contexto
    const ctxPedido = outputContexts.find(c => c.name.includes('pedido_en_proceso'));
    const ctxDir = outputContexts.find(c => c.name.includes('esperando_direccion'));
    const nombre = ctxDir?.parameters?.nombre 
                || ctxPedido?.parameters?.nombre 
                || params.nombre 
                || 'Cliente';

    // Gemini formatea la dirección
    const direccionLimpia = await extraerConIA('direccion', queryText);

    return res.json({
      fulfillmentText: `✅ ¡Listo, ${nombre}!\n\n📋 Tu pedido:\n👤 ${nombre}\n📍 ${direccionLimpia}\n\nTe contactamos pronto para confirmar 🛵💨\n\n¿Necesitas algo más? 😊`,
      outputContexts: [
        {
          name: `${req.body.session}/contexts/esperando_direccion`,
          lifespanCount: 0
        },
        {
          name: `${req.body.session}/contexts/pedido_en_proceso`,
          lifespanCount: 0
        }
      ]
    });
  }

  // ── Cualquier otro intent: dejar que Dialogflow responda normal ──
  return res.json({ fulfillmentText: '' });
});

// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Webhook TastyPostres funcionando ✅' });
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook corriendo en puerto ${PORT}`);
});
