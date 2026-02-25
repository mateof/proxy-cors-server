const { createClient } = require('redis')
const config = require('./config')

let client = null
let connected = false

async function init() {
  try {
    client = createClient({ url: config.REDIS_URL })

    client.on('error', (err) => {
      if (connected) console.error('[Cache] Redis error:', err.message)
      connected = false
    })

    client.on('connect', () => {
      console.log('[Cache] Conectado a Redis')
      connected = true
    })

    client.on('reconnecting', () => {
      console.log('[Cache] Reconectando a Redis...')
    })

    await client.connect()
  } catch (err) {
    console.error('[Cache] No se pudo conectar a Redis:', err.message)
    connected = false
  }
}

async function getCache(url) {
  if (!connected || !client) return null
  try {
    const raw = await client.get('proxy:' + url)
    if (!raw) return null
    return JSON.parse(raw)
  } catch (err) {
    console.error('[Cache] Error al leer:', err.message)
    return null
  }
}

async function setCache(url, data) {
  if (!connected || !client) return
  try {
    await client.set('proxy:' + url, JSON.stringify(data), { EX: config.REDIS_TTL_SECONDS })
  } catch (err) {
    console.error('[Cache] Error al escribir:', err.message)
  }
}

function isHealthy() {
  return connected
}

async function close() {
  if (client) {
    try { await client.quit() } catch {}
  }
}

init()

module.exports = { getCache, setCache, isHealthy, close }
