const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_ID = '1tWNfNk_i34fZRX6DR4RsDgLtr52-Wuv9IDeR3AQlBuA';
const MAPS_API_KEY = process.env.MAPS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return sheetsClient;
}

// ─── PRECIOS ────────────────────────────────────────────────────────────────
const PRECIOS = {
  pastel:   { rebanada: 45, 'pastel completo': 350 },
  helado:   { 'copa sencilla': 30, 'copa doble': 45 },
  gelatina: 20,
  pay:      30,
  galletas: 25,
  yogurt:   25,
  trufas:   35,
  fruta:    { chico: 25, mediano: 35, grande: 50 },
};

function calcularTotal(postre, cantidad, tamanio, tipo) {
  const p    = (postre || '').toLowerCase();
  const cant = parseInt(cantidad) || 1;
  let precio = 0;
  if      (p.includes('pastel'))   precio = PRECIOS.pastel[tamanio]  || 45;
  else if (p.includes('helado'))   precio = PRECIOS.helado[tipo]     || 30;
  else if (p.includes('gelatina')) precio = PRECIOS.gelatina;
  else if (p.includes('pay'))      precio = PRECIOS.pay;
  else if (p.includes('galleta'))  precio = PRECIOS.galletas;
  else if (p.includes('yogurt'))   precio = PRECIOS.yogurt;
  else if (p.includes('trufa'))    precio = PRECIOS.trufas;
  else if (p.includes('fruta'))    precio = PRECIOS.fruta[tamanio]   || 25;
  return precio * cant;
}

// ─── LIMPIEZA MANUAL (fallback cuando Gemini no está disponible) ──────────────
const PREFIJOS_NOMBRE = [
  'el pedido es para', 'el pedido para', 'ponlo a nombre de',
  'a nombre de', 'mi nombre es', 'me llamo', 'soy', 'de parte de',
  'de', 'para', 'nombre'
];

function limpiarNombreManual(texto) {
  let t = texto.trim().toLowerCase();
  const prefijosOrdenados = [...PREFIJOS_NOMBRE].sort((a, b) => b.length - a.length);
  for (const prefijo of prefijosOrdenados) {
    const regex = new RegExp(`^${prefijo}\\s+`, 'i');
    if (regex.test(t)) { t = t.replace(regex, ''); break; }
  }
  t = t.replace(/^[,.:;¿?¡!]+|[,.:;¿?¡!]+$/g, '').trim();
  return t.replace(/\b\w/g, c => c.toUpperCase());
}

const PREFIJOS_DIRECCION = [
  'mi dirección es', 'mi direccion es', 'vivo en', 'mándalo a', 'mandalo a',
  'envíalo a', 'envialo a', 'la dirección es', 'la direccion es',
  'a la dirección', 'a la direccion', 'a la calle', 'queda en',
  'es en', 'está en', 'esta en', 'dirección', 'direccion', 'a'
];

function limpiarDireccionManual(texto) {
  let t = texto.trim();
  const prefijosOrdenados = [...PREFIJOS_DIRECCION].sort((a, b) => b.length - a.length);
  for (const prefijo of prefijosOrdenados) {
    const regex = new RegExp(`^${prefijo}\\s+`, 'i');
    if (regex.test(t)) { t = t.replace(regex, ''); break; }
  }
  t = t.replace(/^[,.:;¿?¡!]+|[,.:;¿?¡!]+$/g, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ─── EXTRACCIÓN CON GEMINI (con fallback automático al manual) ────────────────
async function extraerConIA(tipo, texto) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
    const prompts = {
      nombre: `Extrae SOLO el nombre completo de la persona. Elimina CUALQUIER prefijo como "de", "me llamo", "soy", "a nombre de", "mi nombre es", "el pedido es para", "ponlo a nombre de". Capitaliza cada palabra. Devuelve SOLO el nombre, sin explicaciones, sin puntos.\nEjemplos:\n- "a nombre de luis angel malagon" → "Luis Angel Malagon"\n- "el pedido es para sofia garcia" → "Sofia Garcia"\n- "me llamo juan" → "Juan"\nTexto: "${texto}"\nNombre:`,
      direccion: `Extrae SOLO la dirección. Elimina prefijos como "a", "a la calle", "mi direccion es", "vivo en", "mandalo a". Devuelve SOLO la dirección, sin explicaciones.\nTexto: "${texto}"\nDireccion:`
    };
    const result = await model.generateContent(prompts[tipo]);
    const respuesta = result.response.text().trim().replace(/\.$/, ''); // quitar punto final si lo pone
    if (respuesta) {
      console.log(`Gemini OK [${tipo}]: "${respuesta}"`);
      return respuesta;
    }
    throw new Error('Respuesta vacía de Gemini');
  } catch (err) {
    console.warn(`Gemini no disponible (${err.message}), usando limpieza manual.`);
    return tipo === 'nombre'
      ? limpiarNombreManual(texto)
      : limpiarDireccionManual(texto);
  }
}

// ─── VALIDACIÓN DE DIRECCIÓN CON MAPS ────────────────────────────────────────
async function validarDireccion(direccion) {
  if (!MAPS_API_KEY) {
    console.warn('MAPS_API_KEY no configurada, se usará dirección tal como se recibió.');
    return null;
  }
  return new Promise((resolve) => {
    // Buscar en México específicamente para mejores resultados
    const query = encodeURIComponent(direccion + ', Ciudad de Mexico, Mexico');
    const options = {
      hostname: 'maps.googleapis.com',
      path: `/maps/api/geocode/json?address=${query}&components=country:MX&key=${MAPS_API_KEY}`,
      method: 'GET',
    };
    const https = require('https');
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.status === 'OK') {
            const formatted = data.results[0].formatted_address
              .replace(/,\s*México$/i, '')
              .replace(/,\s*Mexico$/i, '')
              .trim();
            console.log(`Maps OK: "${formatted}"`);
            resolve(formatted);
          } else {
            // Log detallado para ver qué está pasando en Railway
            console.warn(`Maps status: ${data.status} | error_message: ${data.error_message || 'ninguno'} | query: "${direccion}"`);
            resolve(null);
          }
        } catch (e) {
          console.error('Error parseando Maps:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.error('Error Maps API:', e.message);
      resolve(null);
    });
    req.end();
  });
}

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
async function guardarEnSheets(datos) {
  try {
    const sheets = await getSheetsClient();
    const ahora = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
    const resCount = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'A:A' });
    const numFilas = (resCount.data.values || []).length;
    const numPedido = `PED-${String(numFilas).padStart(6, '0')}`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'A:G',
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
    console.log('Pedido guardado:', numPedido);
    return numPedido;
  } catch (err) {
    console.error('Error Sheets:', err.message);
    return 'PED-ERR';
  }
}

// ─── HELPER: leer parámetros de contextos ────────────────────────────────────
function getParam(contexts, ...keys) {
  for (const ctx of contexts) {
    for (const key of keys) {
      if (ctx.parameters?.[key]) return ctx.parameters[key];
    }
  }
  return '';
}

// Construye descripción completa del postre: "gelatina de mango", "pay de limón", etc.
function construirDescPostre(postre, sabor, tamanio, tipo) {
  const p = (postre || '').toLowerCase();
  const partes = [];

  // Sabor primero
  const saborFinal = sabor || tipo || '';

  if (p.includes('pastel')) {
    if (saborFinal) partes.push('pastel de ' + saborFinal);
    else partes.push('pastel');
    if (tamanio) partes.push(tamanio);
  } else if (p.includes('helado')) {
    if (saborFinal) partes.push('helado de ' + saborFinal);
    else partes.push('helado');
    if (tipo) partes.push(tipo); // copa sencilla/doble
  } else if (p.includes('gelatina')) {
    partes.push(saborFinal ? 'gelatina de ' + saborFinal : 'gelatina');
  } else if (p.includes('pay')) {
    partes.push(saborFinal ? 'pay de ' + saborFinal : 'pay');
  } else if (p.includes('galleta')) {
    partes.push(saborFinal ? 'galletas ' + saborFinal : 'galletas');
  } else if (p.includes('yogurt')) {
    partes.push(saborFinal ? 'yogurt de ' + saborFinal : 'yogurt');
  } else if (p.includes('trufa')) {
    partes.push(saborFinal ? 'trufas de ' + saborFinal : 'trufas');
  } else if (p.includes('fruta')) {
    partes.push(tamanio ? 'fruta picada ' + tamanio : 'fruta picada');
  } else {
    partes.push([saborFinal, tamanio, postre].filter(Boolean).join(' '));
  }

  return partes.join(' ').trim();
}

// ─── RUTAS ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Webhook TastyPostres OK' }));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));

app.post('/webhook', async (req, res) => {
  const intentName     = req.body.queryResult?.intent?.displayName || '';
  const queryText      = req.body.queryResult?.queryText           || '';
  const outputContexts = req.body.queryResult?.outputContexts      || [];

  console.log(`Intent: ${intentName} | Query: "${queryText}"`);

  // ── Intent: confirmar_cantidad — propagar acumulados para que no se pierdan ──
  if (intentName === 'confirmar_cantidad') {
    const cantidad = Number(getParam(outputContexts, 'cantidad')) || 1;
    // Preservar acumulados que vengan de agregar_mas_si
    let prevAcumulados = [];
    for (const ctx of outputContexts) {
      if (ctx.parameters?.pedidos_acumulados?.length > 0) {
        prevAcumulados = ctx.parameters.pedidos_acumulados;
        break;
      }
    }
    return res.json({
      fulfillmentText: `Perfecto, ${cantidad}. ¿Quieres agregar algo más?`,
      outputContexts: [
        { name: req.body.session + '/contexts/esperando_agregar_mas', lifespanCount: 5 },
        { name: req.body.session + '/contexts/esperando_cantidad',    lifespanCount: 0 },
        { name: req.body.session + '/contexts/pedido_en_proceso',     lifespanCount: 15, parameters: { pedidos_acumulados: prevAcumulados } },
      ]
    });
  }

  // ── Intent: agregar_mas_no — propagar acumulados a esperando_nombre ──────
  if (intentName === 'agregar_mas_no') {
    let prevAcumulados = [];
    for (const ctx of outputContexts) {
      if (ctx.parameters?.pedidos_acumulados?.length > 0) {
        prevAcumulados = ctx.parameters.pedidos_acumulados;
        break;
      }
    }
    return res.json({
      fulfillmentText: '¡Perfecto! ¿A nombre de quién va el pedido?',
      outputContexts: [
        { name: req.body.session + '/contexts/esperando_agregar_mas', lifespanCount: 0 },
        { name: req.body.session + '/contexts/esperando_nombre',      lifespanCount: 5 },
        { name: req.body.session + '/contexts/pedido_en_proceso',     lifespanCount: 15, parameters: { pedidos_acumulados: prevAcumulados } },
      ]
    });
  }

  // ── Intent: agregar_mas_si — guardar pedido actual antes de que se pierda ──
  if (intentName === 'agregar_mas_si') {
    // DEBUG: ver exactamente qué contextos y parámetros llegan
    console.log('=== CONTEXTOS agregar_mas_si ===');
    for (const ctx of outputContexts) {
      const params = Object.entries(ctx.parameters || {})
        .filter(([k,v]) => v && !k.endsWith('.original'))
        .map(([k,v]) => k + '=' + JSON.stringify(v)).join(', ');
      if (params) console.log(' ', ctx.name.split('/contexts/')[1], ':', params);
    }
    console.log('=== FIN CONTEXTOS ===');
    const postre   = getParam(outputContexts, 'postre');
    const sabor    = getParam(outputContexts, 'sabor_pastel', 'sabor_helado', 'sabor_pay', 'sabor_gelatina', 'sabor_galleta', 'sabor_yogurt', 'sabor_trufa');
    const tamanio  = getParam(outputContexts, 'tamanio_pastel', 'tamanio_postre');
    const tipo     = getParam(outputContexts, 'tipo_helado');
    const cantidad = Number(getParam(outputContexts, 'cantidad')) || 1;

    // Buscar pedidos acumulados en CUALQUIER contexto disponible
    let prevAcumulados = [];
    for (const ctx of outputContexts) {
      if (ctx.parameters?.pedidos_acumulados?.length > 0) {
        prevAcumulados = ctx.parameters.pedidos_acumulados;
        break;
      }
    }

    const postresDesc = construirDescPostre(postre, sabor, tamanio, tipo);
    const totalItem   = calcularTotal(postre, cantidad, tamanio, tipo);
    const pedidosAcumulados = [
      ...prevAcumulados,
      { postre: postresDesc, cantidad, total: totalItem }
    ];

    console.log('Acumulando: ' + cantidad + 'x ' + postresDesc + ' ($' + totalItem + ') | items: ' + pedidosAcumulados.length);

    return res.json({
      fulfillmentText: '¡Claro! 😊 ¿Qué más quieres?\n\nRecuerda que tenemos:\n🍰 Pasteles  🍮 Gelatina  🍦 Helados\n🍪 Galletas  🍫 Trufas  🍓 Fruta picada\n🥧 Pay  🥛 Yogurt',
      outputContexts: [
        { name: req.body.session + '/contexts/esperando_agregar_mas',  lifespanCount: 0 },
        { name: req.body.session + '/contexts/pedido_en_proceso',      lifespanCount: 15, parameters: { pedidos_acumulados: pedidosAcumulados } },
        { name: req.body.session + '/contexts/esperando_nuevo_postre', lifespanCount: 5,  parameters: { pedidos_acumulados: pedidosAcumulados } },
      ]
    });
  }

  // ── Intent: pedir_nombre ──────────────────────────────────────────────────
  if (intentName === 'pedir_nombre') {
    // Limpiar el nombre desde lo que escribió el usuario (queryText)
    const nombre = await extraerConIA('nombre', queryText);

    // Datos del postre ACTUAL
    const postre   = getParam(outputContexts, 'postre');
    const sabor    = getParam(outputContexts, 'sabor_pastel', 'sabor_helado', 'sabor_pay', 'sabor_gelatina', 'sabor_galleta', 'sabor_yogurt', 'sabor_trufa');
    const tamanio  = getParam(outputContexts, 'tamanio_pastel', 'tamanio_postre');
    const tipo     = getParam(outputContexts, 'tipo_helado');
    const cantidad = getParam(outputContexts, 'cantidad');

    // Recuperar pedidos acumulados por agregar_mas_si (ya guardados)
    // o crear la lista con el pedido actual si es un pedido simple
    // Buscar acumulados en TODOS los contextos (confirmar_cantidad puede haberlos pisado)
    let pedidosAnteriores = [];
    for (const ctx of outputContexts) {
      if (ctx.parameters?.pedidos_acumulados?.length > 0) {
        pedidosAnteriores = ctx.parameters.pedidos_acumulados;
        break;
      }
    }

    let pedidosAcumulados;
    if (pedidosAnteriores.length > 0) {
      // Ya se acumularon en agregar_mas_si — solo agregar el último postre pedido
      const postresDesc = construirDescPostre(postre, sabor, tamanio, tipo);
      const totalActual = calcularTotal(postre, cantidad, tamanio, tipo);
      pedidosAcumulados = [
        ...pedidosAnteriores,
        { postre: postresDesc, cantidad, total: totalActual }
      ];
    } else {
      // Pedido simple sin "agregar más"
      const postresDesc = construirDescPostre(postre, sabor, tamanio, tipo);
      const totalActual = calcularTotal(postre, cantidad, tamanio, tipo);
      pedidosAcumulados = [{ postre: postresDesc, cantidad, total: totalActual }];
    }

    return res.json({
      fulfillmentText: `¡Gracias, ${nombre}! 😊\n\n📍 ¿A qué dirección te lo mandamos?\n(Escribe tu calle, número y colonia)`,
      outputContexts: [
        { name: `${req.body.session}/contexts/esperando_nombre`,    lifespanCount: 0 },
        { name: `${req.body.session}/contexts/esperando_direccion`, lifespanCount: 10, parameters: { nombre, pedidos_acumulados: pedidosAcumulados } },
        { name: `${req.body.session}/contexts/pedido_en_proceso`,   lifespanCount: 10, parameters: { nombre, pedidos_acumulados: pedidosAcumulados } },
      ]
    });
  }

  // ── Intent: pedir_direccion / captura_direccion_fallback ──────────────────
  if (intentName === 'pedir_direccion' || intentName === 'captura_direccion_fallback') {
    const ctxDir = outputContexts.find(c => c.name.includes('esperando_direccion'));
    const ctxPed = outputContexts.find(c => c.name.includes('pedido_en_proceso'));
    const p      = ctxDir?.parameters || ctxPed?.parameters || {};

    const nombre            = p.nombre || 'Cliente';
    const pedidosAcumulados = p.pedidos_acumulados || [];

    let resumenPostres = '';
    let cantidadTotal  = 1;
    let totalGeneral   = 0;

    if (pedidosAcumulados.length > 0) {
      // Flujo con webhook acumulando pedidos (agregar más)
      resumenPostres = pedidosAcumulados.map(i => i.postre).join(' + ');
      cantidadTotal  = pedidosAcumulados.reduce((s, i) => s + Number(i.cantidad || 1), 0);
      totalGeneral   = pedidosAcumulados.reduce((s, i) => s + (i.total || 0), 0);
    } else {
      // Flujo normal (1 solo postre) — leer de cualquier contexto disponible
      const postre   = getParam(outputContexts, 'postre') || 'No especificado';
      const sabor    = getParam(outputContexts, 'sabor_pastel', 'sabor_helado', 'sabor_pay',
                                'sabor_gelatina', 'sabor_galleta', 'sabor_yogurt', 'sabor_trufa') || '';
      const tamanio  = getParam(outputContexts, 'tamanio_pastel', 'tamanio_postre') || '';
      const tipo     = getParam(outputContexts, 'tipo_helado') || '';
      const cantidad = Number(getParam(outputContexts, 'cantidad')) || 1;

      resumenPostres = [sabor, tamanio || tipo, postre].filter(Boolean).join(' ');
      cantidadTotal  = cantidad;
      totalGeneral   = calcularTotal(postre, cantidad, tamanio, tipo);
    }

    // Línea del mensaje al usuario (con cantidad visible)
    const resumenMensaje = pedidosAcumulados.length > 0
      ? pedidosAcumulados.map(i => `${i.cantidad}x ${i.postre}`).join('\n🍰 ')
      : `${cantidadTotal}x ${resumenPostres}`;

    const direccionRaw = await extraerConIA('direccion', queryText);
    const direccion    = await validarDireccion(direccionRaw) || direccionRaw;

    // Sheets: postre limpio en col C, cantidad numérica en col D
    const numPedido = await guardarEnSheets({
      nombre,
      postre:   resumenPostres,
      cantidad: cantidadTotal,
      direccion,
      total:    totalGeneral
    });

    return res.json({
      fulfillmentText:
        `✅ ¡Pedido confirmado, ${nombre}!\n\n` +
        `📋 Resumen:\n` +
        `🔖 No. Pedido: ${numPedido}\n` +
        `👤 Nombre: ${nombre}\n` +
        `🍰 ${resumenMensaje}\n` +
        `📍 Dirección: ${direccion}\n` +
        `💰 Total: $${totalGeneral}\n\n` +
        `🛵 Te contactamos pronto para confirmar.\n\n` +
        `¡Gracias por tu compra! 🍰`,
      outputContexts: [
        { name: `${req.body.session}/contexts/esperando_direccion`, lifespanCount: 0 },
        { name: `${req.body.session}/contexts/pedido_en_proceso`,   lifespanCount: 0 },
      ]
    });
  }

  return res.json({ fulfillmentText: '' });
});

app.listen(PORT, () => console.log(`Webhook corriendo en puerto ${PORT}`));
