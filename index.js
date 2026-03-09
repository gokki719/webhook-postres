const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAPS_API_KEY = process.env.MAPS_API_KEY;
const PORT = process.env.PORT || 3000;
const SHEET_ID = '1tWNfNk_i34fZRX6DR4RsDgLtr52-Wuv9lDeR3AQlBuA';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Google Sheets auth
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Precios por producto
const PRECIOS = {
  'pastel': { 'rebanada': 45, 'pastel completo': 350 },
  'helado': { 'copa sencilla': 30, 'copa doble': 45 },
  'gelatina': 25,
  'pay': 35,
  'galletas': 30,
  'yogurt': 35,
  'trufas': 35,
  'fruta': { 'chico': 25, 'mediano': 35, 'grande': 50 },
};

function calcularTotal(postre, cantidad, extras) {
  try {
    const p = postre?.toLowerCase() || '';
    const cant = parseInt(cantidad) || 1;
    let precio = 0;

    if (p.includes('pastel')) {
      precio = extras?.tamanio ? PRECIOS.pastel[extras.tamanio] || 45 : 45;
    } else if (p.includes('helado')) {
      precio = extras?.tipo ? PRECIOS.helado[extras.tipo] || 30 : 30;
    } else if (p.includes('gelatina')) precio = PRECIOS.gelatina;
    else if (p.includes('pay')) precio = PRECIOS.pay;
    else if (p.includes('galleta')) precio = PRECIOS.galletas;
    else if (p.includes('yogurt')) precio = PRECIOS.yogurt;
    else if (p.includes('trufa')) precio = PRECIOS.trufas;
    else if (p.includes('fruta')) {
      precio = extras?.tamanio ? PRECIOS.fruta[extras.tamanio] || 25 : 25;
    }

    return precio * cant;
  } catch (e) {
    return 0;
  }
}

async function guardarEnSheets(datos) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const ahora = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

    // Obtener último número de pedido
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Hoja1!A:A',
    });
    const filas = res.data.values || [];
    const numPedido = `PED-${String(filas.length).padStart(4, '0')}`;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Hoja1!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          numPedido,
          datos.nombre,
          datos.postre,
          datos.cantidad,
          ahora,
          datos.direccion,
          `$${datos.total}`
        ]]
      }
    });
    console.log(`✅ Pedido guardado en Sheets: ${numPedido}`);
    return numPedido;
  } catch (err) {
    console.error('Error Sheets:', err.message);
    return 'PED-ERR';
  }
}

async function validarDireccion(direccion) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(direccion + ', México')}&key=${MAPS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results.length > 0) {
      return data.results[0].formatted_address;
    }
    return null;
  } catch (e) {
    return null;
  }
}

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
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));

app.post('/webhook', async (req, res) => {
  const intentName = req.body.queryResult?.intent?.displayName || '';
  const queryText = req.body.queryResult?.queryText || '';
  const outputContexts = req.body.queryResult?.outputContexts || [];
  const params = req.body.queryResult?.parameters || {};

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

    // Extraer datos del pedido de los contextos
    const postre = ctxPed?.parameters?.postre || params.postre || 'No especificado';
    const cantidad = ctxPed?.parameters?.cantidad || params.cantidad || 1;
    const tamanio = ctxPed?.parameters?.tamanio_pastel || ctxPed?.parameters?.tamanio_postre || '';
    const tipo = ctxPed?.parameters?.tipo_helado || '';

    const direccionRaw = await extraerConIA('direccion', queryText);

    // Validar dirección con Google Maps
    const direccionValidada = await validarDireccion(direccionRaw);
    const direccion = direccionValidada || direccionRaw;

    const total = calcularTotal(postre, cantidad, { tamanio, tipo });

    // Guardar en Google Sheets
    const numPedido = await guardarEnSheets({ nombre, postre, cantidad, direccion, total });

    return res.json({
      fulfillmentText: `✅ ¡Pedido confirmado, ${nombre}!\n\n📋 Resumen:\n🔖 Pedido: ${numPedido}\n👤 Nombre: ${nombre}\n🍰 Postre: ${postre}\n🔢 Cantidad: ${cantidad}\n📍 Dirección: ${direccion}\n💰 Total: $${total}\n\n🛵 Te contactamos pronto para confirmar la entrega.\n\n¡Gracias por tu compra! 🍰`,
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
