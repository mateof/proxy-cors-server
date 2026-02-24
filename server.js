const path = require('path')
const express = require('express')
const helmet = require('helmet')
const morgan = require('morgan')
const cookieSession = require('cookie-session')
const config = require('./config')
const db = require('./db')
const telegram = require('./telegram')
const cache = require('./cache')

const app = express()

// Trust proxy (para obtener IP real detrás de reverse proxy / Docker)
app.set('trust proxy', true)

// EJS
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

// Seguridad (relajar CSP para el dashboard con inline styles/scripts)
app.use(helmet({
  contentSecurityPolicy: false,
}))

// Logging HTTP en consola
app.use(morgan('short'))

// Sesión para el dashboard
app.use(cookieSession({
  name: 'proxy_session',
  secret: config.SESSION_SECRET,
  maxAge: 24 * 60 * 60 * 1000, // 24 horas
  httpOnly: true,
  sameSite: 'lax',
}))

// Body parsers
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

// --- Utilidades ---

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function isLocalNetwork(ip) {
  return config.DASHBOARD_ALLOWED_NETS.some(net => ip.includes(net))
}

// --- Middlewares del proxy ---

function validateOrigin(req, res, next) {
  const origin = req.get('Origin') || req.get('Referer') || ''

  if (!origin) {
    if (req.path.startsWith('/proxy')) {
      res.status(403).json({ error: 'Origin header requerido' })
      return
    }
    next()
    return
  }

  const allowed = config.ALLOWED_ORIGINS.some(o => origin.startsWith(o))
  if (!allowed) {
    res.status(403).json({ error: 'Origen no permitido' })
    return
  }

  next()
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req)

  if (db.isBlocked(ip)) {
    res.status(429).json({ error: 'IP bloqueada por exceso de peticiones' })
    return
  }

  const ipCount = db.getRequestCountByIp(ip, config.RATE_LIMIT_WINDOW_MS)
  if (ipCount >= config.RATE_LIMIT_PER_IP) {
    const reason = `Excedido límite por IP: ${ipCount}/${config.RATE_LIMIT_PER_IP}`
    db.blockIp(ip, reason)
    telegram.notifyIpBlocked(ip, reason)
    res.status(429).json({ error: 'Límite de peticiones por IP excedido. IP bloqueada.' })
    return
  }

  const globalCount = db.getGlobalRequestCount(config.RATE_LIMIT_WINDOW_MS)
  if (globalCount >= config.RATE_LIMIT_GLOBAL) {
    telegram.notifyGlobalLimit(globalCount)
    res.status(429).json({ error: 'Límite global de peticiones excedido. Inténtalo más tarde.' })
    return
  }

  next()
}

function corsHeaders(req, res, next) {
  const origin = req.get('Origin')
  if (origin && config.ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.set('Access-Control-Max-Age', '86400')
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  next()
}

// --- Middlewares del dashboard ---

function requireLocalNetwork(req, res, next) {
  const ip = getClientIp(req)
  if (!isLocalNetwork(ip)) {
    res.status(403).send('Acceso denegado: solo red local')
    return
  }
  next()
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    next()
    return
  }
  res.redirect('/dashboard/login')
}

// --- Rangos de tiempo válidos (whitelist contra inyección SQL) ---

const VALID_RANGES = {
  '1h':  { since: '-1 hour',   groupFormat: '%H:%M' },
  '6h':  { since: '-6 hours',  groupFormat: '%H:00' },
  '24h': { since: '-24 hours', groupFormat: '%H:00' },
  '7d':  { since: '-7 days',   groupFormat: '%m-%d' },
  '30d': { since: '-30 days',  groupFormat: '%Y-%m-%d' },
}
const DEFAULT_RANGE = '1h'
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

function buildTimeFilter(rangeKey, from, to) {
  if (from && to && ISO_RE.test(from) && ISO_RE.test(to)) {
    return `timestamp >= '${from.replace('T', ' ')}' AND timestamp <= '${to.replace('T', ' ')}'`
  }
  const range = VALID_RANGES[rangeKey] || VALID_RANGES[DEFAULT_RANGE]
  return `timestamp > datetime('now', '${range.since}')`
}

function resolveGroupFormat(rangeKey, from, to) {
  if (from && to && ISO_RE.test(from) && ISO_RE.test(to)) {
    const diffMs = new Date(to) - new Date(from)
    const diffHours = diffMs / (1000 * 60 * 60)
    if (diffHours <= 2) return '%H:%M'
    if (diffHours <= 48) return '%H:00'
    if (diffHours <= 14 * 24) return '%m-%d'
    return '%Y-%m-%d'
  }
  const range = VALID_RANGES[rangeKey] || VALID_RANGES[DEFAULT_RANGE]
  return range.groupFormat
}

// --- Rutas del dashboard (solo red local + auth) ---

app.get('/dashboard/login', requireLocalNetwork, (req, res) => {
  if (req.session && req.session.authenticated) {
    res.redirect('/dashboard')
    return
  }
  res.render('login', { error: null })
})

app.post('/dashboard/login', requireLocalNetwork, (req, res) => {
  const { user, pass } = req.body
  if (user === config.DASHBOARD_USER && pass === config.DASHBOARD_PASS) {
    req.session.authenticated = true
    res.redirect('/dashboard')
  } else {
    res.render('login', { error: 'Usuario o contraseña incorrectos' })
  }
})

app.get('/dashboard/logout', (req, res) => {
  req.session = null
  res.redirect('/dashboard/login')
})

app.get('/dashboard', requireLocalNetwork, requireAuth, (req, res) => {
  const timeFilter = buildTimeFilter(DEFAULT_RANGE)
  const groupFormat = resolveGroupFormat(DEFAULT_RANGE)
  const data = db.getDashboardData(timeFilter, groupFormat)
  data.recentRequests = db.getRecentRequests(50)
  data.lastRequestId = db.getLastRequestId()
  data.cacheStatus = cache.isHealthy()
  res.render('dashboard', { data, ranges: Object.keys(VALID_RANGES), defaultRange: DEFAULT_RANGE })
})

// API de polling para actualizaciones en tiempo real
app.get('/dashboard/api/poll', requireLocalNetwork, requireAuth, (req, res) => {
  const afterId = parseInt(req.query.after) || 0
  const { range, from, to } = req.query
  const timeFilter = buildTimeFilter(range, from, to)
  const groupFormat = resolveGroupFormat(range, from, to)
  const stats = db.getDashboardData(timeFilter, groupFormat)
  const newRequests = db.getRequestsAfterId(afterId)
  const cacheStatus = cache.isHealthy()
  res.json({ stats, newRequests, cacheStatus })
})

// API para desbloquear IP desde el dashboard
app.post('/dashboard/api/unblock/:ip', requireLocalNetwork, requireAuth, (req, res) => {
  db.unblockIp(req.params.ip)
  res.json({ ok: true })
})

// API para obtener configuración de Telegram
app.get('/dashboard/api/settings', requireLocalNetwork, requireAuth, (req, res) => {
  res.json(telegram.getEffectiveConfig())
})

// API para guardar configuración de Telegram
app.post('/dashboard/api/settings', requireLocalNetwork, requireAuth, (req, res) => {
  const { key, value } = req.body
  if (!key) {
    res.status(400).json({ error: 'Campo "key" requerido' })
    return
  }
  db.setSetting(key, String(value))
  res.json({ ok: true })
})

// API para enviar mensaje de prueba de Telegram
app.post('/dashboard/api/telegram/test', requireLocalNetwork, requireAuth, async (req, res) => {
  const result = await telegram.sendMessage('*TEST* — Proxy CORS: notificaciones Telegram funcionando correctamente.')
  res.json(result)
})

// --- Rutas del proxy ---

app.use(corsHeaders)
app.use(validateOrigin)

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), redis: cache.isHealthy() })
})

app.get('/proxy', rateLimit, async (req, res) => {
  const ip = getClientIp(req)
  const origin = req.get('Origin') || ''
  const targetUrl = req.query.url

  if (!targetUrl) {
    res.status(400).json({ error: 'Parámetro "url" requerido. Ejemplo: /proxy?url=https://ejemplo.com/api' })
    return
  }

  let parsed
  try {
    parsed = new URL(targetUrl)
  } catch {
    res.status(400).json({ error: 'URL no válida' })
    return
  }

  const targetOrigin = parsed.origin
  if (!config.TARGET_ALLOWLIST.some(allowed => targetOrigin === allowed)) {
    telegram.notifyForbiddenDomain(parsed.hostname, ip)
    res.status(403).json({ error: `Dominio no permitido: ${parsed.hostname}. Dominios permitidos: ${config.TARGET_ALLOWLIST.join(', ')}` })
    return
  }

  const start = Date.now()

  // Comprobar caché
  const cached = await cache.getCache(targetUrl)
  if (cached) {
    const responseTime = Date.now() - start
    db.logRequest({ ip, origin, method: 'GET', path: targetUrl, status: cached.status, responseTime, cacheHit: 1 })
    res.status(cached.status)
    res.set('Content-Type', cached.contentType)
    res.set('X-Cache', 'HIT')
    res.send(Buffer.from(cached.body, 'base64'))
    return
  }

  try {
    const response = await fetch(targetUrl)
    const contentType = response.headers.get('content-type') || ''
    const body = await response.arrayBuffer()
    const responseTime = Date.now() - start

    // Guardar en caché solo respuestas exitosas
    if (response.status >= 200 && response.status < 400) {
      cache.setCache(targetUrl, {
        body: Buffer.from(body).toString('base64'),
        contentType,
        status: response.status,
      })
    }

    db.logRequest({ ip, origin, method: 'GET', path: targetUrl, status: response.status, responseTime, cacheHit: 0 })

    res.status(response.status)
    res.set('Content-Type', contentType)
    res.set('X-Cache', 'MISS')
    res.send(Buffer.from(body))
  } catch (err) {
    const responseTime = Date.now() - start
    db.logRequest({ ip, origin, method: 'GET', path: targetUrl, status: 502, responseTime, cacheHit: 0 })
    res.status(502).json({ error: 'Error al conectar con el destino', details: err.message })
  }
})

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada. Usa /proxy?url=<URL> para el proxy.' })
})

// --- Arrancar servidor ---

const server = app.listen(config.PORT, () => {
  console.log(`Proxy CORS escuchando en puerto ${config.PORT}`)
  console.log(`Orígenes permitidos: ${config.ALLOWED_ORIGINS.join(', ')}`)
  console.log(`Dominios destino permitidos: ${config.TARGET_ALLOWLIST.join(', ')}`)
  console.log(`Rate limit: ${config.RATE_LIMIT_PER_IP}/IP, ${config.RATE_LIMIT_GLOBAL} global (ventana ${config.RATE_LIMIT_WINDOW_MS / 1000}s)`)
  console.log(`Dashboard: http://localhost:${config.PORT}/dashboard (solo red local)`)
  console.log(`Telegram: ${config.TELEGRAM_ENABLED ? 'activado' : 'desactivado'}`)
  console.log(`Redis: ${config.REDIS_URL} (TTL ${config.REDIS_TTL_SECONDS}s)`)
})

process.on('SIGTERM', () => {
  console.log('Cerrando servidor...')
  server.close(async () => { await cache.close(); db.close(); process.exit(0) })
})

process.on('SIGINT', () => {
  console.log('Cerrando servidor...')
  server.close(async () => { await cache.close(); db.close(); process.exit(0) })
})
