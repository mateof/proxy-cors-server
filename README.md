# Proxy CORS

Proxy CORS genérico con rate-limiting, logging en SQLite y panel de monitorización.

Permite que aplicaciones frontend (como GitHub Pages) accedan a APIs externas que no envían cabeceras CORS, proxeando las peticiones a través de un servidor intermedio con una whitelist de dominios destino.

## Funcionalidades

- **Proxy CORS genérico**: reenvía peticiones `/proxy?url=<URL>` a cualquier dominio de la whitelist, añadiendo cabeceras CORS
- **Whitelist de dominios destino**: solo proxea peticiones a dominios configurados (403 para el resto)
- **Whitelist de orígenes**: solo acepta peticiones de orígenes configurados (403 para el resto)
- **Rate-limiting**: límite por IP y global, con bloqueo automático de IPs que excedan el límite
- **Logging SQLite**: cada petición se registra con IP, origen, ruta, código de estado y tiempo de respuesta
- **Dashboard de monitorización**: panel web con estadísticas en tiempo real, protegido por login y accesible solo desde red local
- **Caché Redis**: caché de respuestas exitosas con TTL configurable, indicador de estado Redis en el dashboard y degradación elegante si Redis no está disponible
- **Alertas Telegram**: notificaciones configurables al bloquear IPs, alcanzar límite global o detectar intentos repetidos a dominios no permitidos

## Stack

- Node.js 20+
- Express 4
- better-sqlite3 (logging y rate-limiting)
- EJS (dashboard)
- cookie-session (autenticación dashboard)
- helmet (seguridad HTTP)
- morgan (logging en consola)
- Redis 7+ (caché de respuestas)

## Estructura del proyecto

```
proxyCors/
├── server.js           # Servidor Express principal
├── config.js           # Configuración centralizada
├── db.js               # SQLite: tablas, queries y funciones
├── cache.js            # Caché Redis con degradación elegante
├── telegram.js         # Notificaciones Telegram
├── views/
│   ├── login.ejs       # Pantalla de login del dashboard
│   └── dashboard.ejs   # Panel de monitorización
├── data/               # Base de datos SQLite (se crea automáticamente)
├── package.json
├── Dockerfile
├── docker-compose.yml
└── .dockerignore
```

## Instalación

### Directo con Node.js

```bash
npm install
npm start
```

### Con Docker

```bash
docker compose up -d
```

El servidor arranca en el puerto **3010** por defecto.

## Configuración

Todas las opciones se configuran mediante **variables de entorno** (o se editan los valores por defecto en `config.js`).

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3010` |
| `ALLOWED_ORIGINS` | Orígenes permitidos (separados por coma) | `https://mateof.github.io,http://localhost:5173` |
| `TARGET_ALLOWLIST` | Dominios destino permitidos (separados por coma) | `https://cima.aemps.es` |
| `RATE_LIMIT_PER_IP` | Máximo de peticiones por IP por ventana | `100` |
| `RATE_LIMIT_GLOBAL` | Máximo de peticiones totales por ventana | `1000` |
| `RATE_LIMIT_WINDOW_MS` | Ventana de tiempo en ms | `900000` (15 min) |
| `DB_PATH` | Ruta de la base de datos SQLite | `./data/proxy.db` |
| `DASHBOARD_USER` | Usuario del dashboard | `admin` |
| `DASHBOARD_PASS` | Contraseña del dashboard | `admin` |
| `SESSION_SECRET` | Secreto para firmar cookies de sesión | `cambiar-este-secreto-en-produccion` |
| `REDIS_URL` | URL de conexión a Redis | `redis://localhost:6379` |
| `REDIS_TTL` | Tiempo de vida de la caché (`300`, `300s`, `5m`, `2h`, `1d`) | `5m` |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram | _(vacío = desactivado)_ |
| `TELEGRAM_CHAT_ID` | ID del chat donde enviar alertas | _(vacío = desactivado)_ |
| `TELEGRAM_NOTIFY_ON_BLOCK` | Notificar al bloquear una IP | `true` |
| `TELEGRAM_NOTIFY_ON_GLOBAL_LIMIT` | Notificar al alcanzar límite global | `true` |
| `TELEGRAM_NOTIFY_ON_FORBIDDEN_DOMAIN` | Notificar intentos a dominios no permitidos | `true` |
| `TELEGRAM_FORBIDDEN_DOMAIN_THRESHOLD` | Intentos a dominio prohibido antes de notificar | `5` |
| `TELEGRAM_COOLDOWN_MS` | Cooldown entre alertas del mismo tipo (ms) | `60000` (1 min) |

> **Importante**: cambiar `DASHBOARD_PASS` y `SESSION_SECRET` antes de desplegar en producción.

### Configurar Telegram

1. Crear un bot con [@BotFather](https://t.me/BotFather) y copiar el token
2. Obtener el `chat_id` enviando un mensaje al bot y consultando `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Configurar las variables de entorno:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_ID=987654321
```

Las notificaciones se activan automáticamente al configurar ambas variables. Se envían alertas cuando:
- Se **bloquea una IP** por exceder el rate limit
- Se alcanza el **límite global** de peticiones
- Se detectan **intentos repetidos** (por defecto 5) a dominios no permitidos

Alternativamente, se puede configurar todo desde el **panel del dashboard** (sección "Notificaciones Telegram") sin necesidad de variables de entorno. Los valores se guardan en la base de datos SQLite y se aplican sin reiniciar el servidor.

> **Prioridad**: variable de entorno > valor en base de datos > valor por defecto. Si una variable de entorno está definida, el campo correspondiente del dashboard aparece deshabilitado.

## Rutas

### Proxy

| Ruta | Método | Descripción |
|---|---|---|
| `GET /proxy?url=<URL>` | GET | Proxy genérico. La URL debe pertenecer a un dominio de `TARGET_ALLOWLIST`. Requiere cabecera `Origin` de un origen permitido. Sujeto a rate-limiting. |
| `GET /health` | GET | Health check. Devuelve `{ status: "ok", uptime: ... }` |

### Dashboard (solo red local)

| Ruta | Descripción |
|---|---|
| `GET /dashboard` | Panel de monitorización (requiere login) |
| `GET /dashboard/login` | Pantalla de login |
| `POST /dashboard/login` | Procesar login |
| `GET /dashboard/logout` | Cerrar sesión |
| `GET /dashboard/api/poll?after=ID` | API de polling para actualizaciones en tiempo real |
| `POST /dashboard/api/unblock/:ip` | Desbloquear una IP |

## Dashboard

El panel de monitorización muestra:

- **Resumen**: peticiones hoy, última hora, tiempo medio de respuesta, errores, IPs únicas, IPs bloqueadas
- **Gráfico**: peticiones por hora (últimas 24h)
- **Top IPs**: las 10 IPs con más peticiones del día
- **Top rutas**: las 10 rutas más solicitadas del día
- **Códigos de estado**: distribución de respuestas HTTP del día
- **Feed en tiempo real**: peticiones entrantes actualizadas cada 3 segundos
- **IPs bloqueadas**: lista con opción de desbloquear

### Seguridad del dashboard

- Solo accesible desde **red local** (127.0.0.1, 192.168.x.x, 10.x.x.x, 172.16-31.x.x)
- Requiere **login** con usuario y contraseña
- No expuesto a internet aunque el proxy sí lo esté

## Rate-limiting

El sistema funciona en dos niveles:

1. **Por IP**: si una IP supera `RATE_LIMIT_PER_IP` peticiones en la ventana de tiempo, se **bloquea automáticamente** y todas sus peticiones posteriores reciben un `429`
2. **Global**: si el total de peticiones de todas las IPs supera `RATE_LIMIT_GLOBAL`, se devuelve `429` a todas las peticiones hasta que se cierre la ventana

Las IPs bloqueadas se pueden desbloquear manualmente desde el dashboard.

## Base de datos

SQLite con dos tablas:

### `requests`
Registro de cada petición al proxy.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | INTEGER | Clave primaria autoincremental |
| `timestamp` | TEXT | Fecha y hora (UTC) |
| `ip` | TEXT | IP del cliente |
| `origin` | TEXT | Cabecera Origin de la petición |
| `method` | TEXT | Método HTTP |
| `path` | TEXT | Ruta solicitada |
| `status` | INTEGER | Código de estado de la respuesta |
| `response_time_ms` | INTEGER | Tiempo de respuesta en milisegundos |

### `blocks`
IPs bloqueadas por rate-limiting.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | INTEGER | Clave primaria autoincremental |
| `ip` | TEXT | IP bloqueada (única) |
| `blocked_at` | TEXT | Fecha y hora del bloqueo |
| `reason` | TEXT | Motivo del bloqueo |

La base de datos se almacena en `./data/proxy.db` y se crea automáticamente al iniciar el servidor. Con Docker, el directorio `data/` se monta como volumen persistente.

## Ejemplo de petición

```bash
# Petición con origen permitido a CIMA
curl -H "Origin: https://mateof.github.io" \
  "http://localhost:3010/proxy?url=https://cima.aemps.es/cima/rest/medicamentos?nombre=ibuprofeno"

# Petición con origen no permitido → 403
curl -H "Origin: https://otro-sitio.com" \
  "http://localhost:3010/proxy?url=https://cima.aemps.es/cima/rest/medicamentos?nombre=ibuprofeno"

# Petición a dominio no permitido → 403
curl -H "Origin: https://mateof.github.io" \
  "http://localhost:3010/proxy?url=https://otro-dominio.com/api/datos"

# Health check
curl http://localhost:3010/health
```
