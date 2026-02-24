const config = require('./config')
const db = require('./db')

// Defaults para cada clave de Telegram
const DEFAULTS = {
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  TELEGRAM_NOTIFY_ON_BLOCK: 'true',
  TELEGRAM_NOTIFY_ON_GLOBAL_LIMIT: 'true',
  TELEGRAM_NOTIFY_ON_FORBIDDEN_DOMAIN: 'true',
  TELEGRAM_FORBIDDEN_DOMAIN_THRESHOLD: '5',
  TELEGRAM_COOLDOWN_MS: '60000',
}

// Prioridad: env var > BBDD > default
function getConfig(key) {
  if (process.env[key]) return process.env[key]
  const dbVal = db.getSetting(key)
  if (dbVal !== null) return dbVal
  return DEFAULTS[key] || ''
}

function isEnabled() {
  const token = getConfig('TELEGRAM_BOT_TOKEN')
  const chatId = getConfig('TELEGRAM_CHAT_ID')
  return !!(token && chatId)
}

function isTruthy(key) {
  return getConfig(key) === 'true'
}

// Cooldown: última vez que se envió cada tipo de alerta
const lastSent = new Map()

// Contador de intentos a dominios prohibidos (hostname → count)
const forbiddenDomainAttempts = new Map()

function canSend(alertType) {
  if (!isEnabled()) return false
  const last = lastSent.get(alertType) || 0
  const cooldown = parseInt(getConfig('TELEGRAM_COOLDOWN_MS')) || 60000
  return Date.now() - last >= cooldown
}

function markSent(alertType) {
  lastSent.set(alertType, Date.now())
}

async function sendMessage(text) {
  const token = getConfig('TELEGRAM_BOT_TOKEN')
  const chatId = getConfig('TELEGRAM_CHAT_ID')
  if (!token || !chatId) return { ok: false, error: 'Token o Chat ID no configurados' }

  const url = `https://api.telegram.org/bot${token}/sendMessage`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error(`[Telegram] Error ${res.status}: ${body}`)
      return { ok: false, error: `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (err) {
    console.error(`[Telegram] Error enviando mensaje: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

function notifyIpBlocked(ip, reason) {
  if (!isTruthy('TELEGRAM_NOTIFY_ON_BLOCK')) return
  if (!canSend(`block:${ip}`)) return
  markSent(`block:${ip}`)

  const text = [
    '*IP BLOQUEADA*',
    `*IP:* \`${ip}\``,
    `*Razón:* ${reason}`,
    `*Hora:* ${new Date().toISOString()}`,
  ].join('\n')

  sendMessage(text).catch(() => {})
}

function notifyGlobalLimit(count) {
  if (!isTruthy('TELEGRAM_NOTIFY_ON_GLOBAL_LIMIT')) return
  if (!canSend('global_limit')) return
  markSent('global_limit')

  const windowMin = Math.round(config.RATE_LIMIT_WINDOW_MS / 60000)
  const text = [
    '*LIMITE GLOBAL ALCANZADO*',
    `*Peticiones:* ${count}/${config.RATE_LIMIT_GLOBAL}`,
    `*Ventana:* ${windowMin} min`,
    `*Hora:* ${new Date().toISOString()}`,
  ].join('\n')

  sendMessage(text).catch(() => {})
}

function notifyForbiddenDomain(hostname, ip) {
  if (!isTruthy('TELEGRAM_NOTIFY_ON_FORBIDDEN_DOMAIN')) return

  const count = (forbiddenDomainAttempts.get(hostname) || 0) + 1
  forbiddenDomainAttempts.set(hostname, count)

  const threshold = parseInt(getConfig('TELEGRAM_FORBIDDEN_DOMAIN_THRESHOLD')) || 5
  if (count < threshold) return
  if (!canSend(`forbidden:${hostname}`)) return
  markSent(`forbidden:${hostname}`)

  // Resetear contador tras notificar
  forbiddenDomainAttempts.set(hostname, 0)

  const text = [
    '*DOMINIO NO PERMITIDO*',
    `*Dominio:* \`${hostname}\``,
    `*Intentos:* ${count}`,
    `*Última IP:* \`${ip}\``,
    `*Hora:* ${new Date().toISOString()}`,
  ].join('\n')

  sendMessage(text).catch(() => {})
}

// Exponer para el endpoint de test y la API de settings
function getEffectiveConfig() {
  const keys = Object.keys(DEFAULTS)
  const result = {}
  for (const key of keys) {
    const envVal = process.env[key] || ''
    const dbVal = db.getSetting(key)
    result[key] = {
      value: getConfig(key),
      source: envVal ? 'env' : (dbVal !== null ? 'db' : 'default'),
    }
  }
  return result
}

module.exports = {
  notifyIpBlocked,
  notifyGlobalLimit,
  notifyForbiddenDomain,
  sendMessage,
  getEffectiveConfig,
}
