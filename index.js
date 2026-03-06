const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

function limpiarManual(tipo, texto) {
  let t = texto.trim();
  if (tipo === 'nombre') {
    t = t.replace(/^(me llamo|mi nombre es|soy|a nombre de|ponlo a nombre de|el nombre es|de)\s+/i, '');
  } else {
    t = t.replace(/^(mi dirección es|vivo en|mándalo a|envíalo a|la dirección es|a la dirección|a la calle|queda en|a)\s+/i, '');
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function extraerConIA(tipo, texto) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompts = {
      nombre: `Extrae SOLO el nombre completo de la persona. Elimina prefijos como "de", "me llamo", "soy", "a nombre de", "mi nombre es". Capitaliza correctamente. Devuelve SOLO el nombre sin puntos.\nTexto: "${texto}"\nNombre:`,
      direccion: `Extrae SOLO la dirección. Elimina prefijos como "a", "a la calle", "mi dirección es", "vivo en", "mándalo a". Devuelve SOLO la dirección limpia.\nTexto: "${texto}"\nDirección:`
    };
    const result = await model.generateContent(prompts[tipo]);
    const respuesta = result.response.text().trim();
    return respuesta || limpiarManual(tipo, texto);
  } catch (err) {
    console.error('Error Gemini:', err.message);
    return limpiarManual(tipo, texto);
  }
}

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Webhook TastyPostres ✅' }));

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

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
      fulfillmentText: `✅ ¡Listo, ${nombre}!\n\n📋 Resumen de tu pedido:\n👤 Nombre: ${nombre}\n📍 Dirección: ${direccion}\n\n🛵 Te contactamos pronto para confirmar la entrega.\n\n¡Gracias por tu compra! 🍰`,
      outputContexts: [
        { name: `${req.body.session}/contexts/esperando_direccion`, lifespanCount: 0 },
        { name: `${req.body.session}/contexts/pedido_en_proceso`, lifespanCount: 0 },
        { name: `${req.body.session}/contexts/pedido_confirmado`, lifespanCount: 2 }
      ]
    });
  }

  return res.json({ fulfillmentText: '' });
});

app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
