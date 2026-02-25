module.exports = {
  PORT: process.env.PORT || 3010,

  // Orígenes permitidos (separados por coma en la variable de entorno)
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'https://mateof.github.io,http://localhost:5173').split(','),

  // Dominios destino permitidos (separados por coma en la variable de entorno)
  TARGET_ALLOWLIST: (process.env.TARGET_ALLOWLIST || 'https://cima.aemps.es').split(','),

  // Rate limiting por IP (peticiones por ventana de tiempo)
  RATE_LIMIT_PER_IP: parseInt(process.env.RATE_LIMIT_PER_IP || '100'),

  // Rate limiting global (total de peticiones por ventana)
  RATE_LIMIT_GLOBAL: parseInt(process.env.RATE_LIMIT_GLOBAL || '1000'),

  // Ventana de tiempo en milisegundos (por defecto 15 minutos)
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),

  // Ruta de la base de datos SQLite
  DB_PATH: process.env.DB_PATH || './data/proxy.db',

  // Dashboard — credenciales de acceso
  DASHBOARD_USER: process.env.DASHBOARD_USER || 'admin',
  DASHBOARD_PASS: process.env.DASHBOARD_PASS || 'admin',

  // Secreto para firmar las cookies de sesión
  SESSION_SECRET: process.env.SESSION_SECRET || 'cambiar-este-secreto-en-produccion',

  // IPs de red local permitidas para acceder al dashboard
  DASHBOARD_ALLOWED_NETS: ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.', '10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.'],

  // --- Telegram ---

  // Token del bot y chat ID (obligatorios para activar notificaciones)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  // Se activa automáticamente si hay token y chat_id, o se puede forzar
  TELEGRAM_ENABLED: process.env.TELEGRAM_ENABLED === 'true' || !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),

  // Qué eventos notificar
  TELEGRAM_NOTIFY_ON_BLOCK: process.env.TELEGRAM_NOTIFY_ON_BLOCK !== 'false',
  TELEGRAM_NOTIFY_ON_GLOBAL_LIMIT: process.env.TELEGRAM_NOTIFY_ON_GLOBAL_LIMIT !== 'false',
  TELEGRAM_NOTIFY_ON_FORBIDDEN_DOMAIN: process.env.TELEGRAM_NOTIFY_ON_FORBIDDEN_DOMAIN !== 'false',

  // Umbral de intentos a dominios no permitidos antes de notificar
  TELEGRAM_FORBIDDEN_DOMAIN_THRESHOLD: parseInt(process.env.TELEGRAM_FORBIDDEN_DOMAIN_THRESHOLD || '5'),

  // Cooldown entre notificaciones del mismo tipo (ms) para evitar spam
  TELEGRAM_COOLDOWN_MS: parseInt(process.env.TELEGRAM_COOLDOWN_MS || '60000'),

  // --- Redis ---

  // URL de conexión a Redis (formato redis://host:port)
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // Tiempo de vida de la caché (formatos: 300, 300s, 5m, 2h, 1d)
  REDIS_TTL_SECONDS: parseTTL(process.env.REDIS_TTL || '5m'),
}

function parseTTL(value) {
  const match = String(value).trim().match(/^(\d+)\s*(s|m|h|d)?$/i)
  if (!match) return 300
  const num = parseInt(match[1])
  switch ((match[2] || 's').toLowerCase()) {
    case 's': return num
    case 'm': return num * 60
    case 'h': return num * 3600
    case 'd': return num * 86400
    default:  return num
  }
}
