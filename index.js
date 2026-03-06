const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function extraerConIA(tipo, texto) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompts = {
      nombre: `Extrae SOLO el nombre de la persona del siguiente texto. Quita prefijos como "me llamo", "soy", "a nombre de", "mi nombre es". Devuelve SOLO el nombre sin puntos ni explicaciones.\nTexto: "${texto}"\nNombre:`,
      direccion: `Limpia y devuelve la dirección del siguiente texto tal como está, solo quita frases como "mi dirección es", "vivo en", "mándalo a". Devuelve SOLO la dirección.\nTexto: "${texto}"\nDirección:`
    };
    const result = await model.generateContent(prompts[tipo]);
    const respuesta = result.response.text().trim();
    return respuesta || texto;
  } catch (err) {
    console.error('Error Gemini:', err.message);
    // Si Gemini falla, limpiar el texto manualmente
    let limpio = texto
      .replace(/^(me llamo|mi nombre es|soy|a nombre de|ponlo a nombre de)\s*/i, '')
      .replace(/^(mi dirección es|vivo en|mándalo a|envíalo a|la dirección es|a la dirección|a la calle|queda en)\s*/i, '')
      .trim();
    return limpio || texto;
  }
}

app.post('/webhook', async (req, res) => {
  const intentName = req.body.queryResult?.intent?.displayName || '';
  const queryText = req.body.queryResult?.queryText || '';
  const outputContexts = req.body.queryResult?.outputContexts || [];

  console.log(`Intent: ${intentName} | Query: "${queryText}"`);

  if (intentName === 'pedir_nombre') {
    const nombre = await extraerConIA('nombre', queryText);
    return res.json({
      fulfillmentText: `¡Gracias, ${nombre}! 😊\n\n📍 ¿A qué dirección te lo mandamos?\n(Escribe tu calle, número y colonia)`,
      outputContexts: [
        { name: `${req.body.session}/contexts/esperando_nombre`, lifespanCount: 0 },
        { name: `${req.body.session}/contexts/esperando_direccion`, lifespanCount: 10, parameters: { nombre } },
        { name: `${req.body.session}/contexts/pedido_en_proceso`, lifespanCount: 10, parameters: { nombre } }
      ]
    });
  }

  if (intentName === 'pedir_direccion' || intentName === 'captura_direccion_fallback') {
    const ctxDir = outputContexts.find(c => c.name.includes('esperando_direccion'));
    const ctxPed = outputContexts.find(c => c.name.includes('pedido_en_proceso'));
    const nombre = ctxDir?.parameters?.nombre || ctxPed?.parameters?.nombre || 'Cliente';
    const direccion = await extraerConIA('direccion', queryText);
    return res.json({
      fulfillmentText: `✅ ¡Listo, ${nombre}!\n\n📋 Tu pedido:\n👤 ${nombre}\n📍 ${direccion}\n\nTe contactamos pronto 🛵💨\n\n¿Necesitas algo más? 😊`,
      outputContexts: [
        { name: `${req.body.session}/contexts/esperando_direccion`, lifespanCount: 0 },
        { name: `${req.body.session}/contexts/pedido_en_proceso`, lifespanCount: 0 }
      ]
    });
  }

  return res.json({ fulfillmentText: '' });
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Webhook TastyPostres ✅' }));

app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
