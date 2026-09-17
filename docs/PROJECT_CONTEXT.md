# PuzzleLove — Contexto del proyecto para agentes

Este documento resume todo lo que un agente nuevo necesita para continuar el trabajo sin repetir decisiones ya tomadas.
Última actualización: 2026-09-17.

## 1. Sobre el usuario

- Habla español. Responde en español.
- Trabaja con Azure y Blob Storage en su empleo actual.
- Objetivo del proyecto: **llenar su CV** para vacantes de datos y cloud. La lista de requisitos que busca cubrir:
  pipelines de datos, analítica y visualización, desarrollo de software, ETL/ELT y big data (Spark),
  cloud computing y almacenamiento, y arquitectura de soluciones.
- Solo tiene disponible **un VPS de 8 GB de RAM** (todavía no está listo). No va a usar AWS, GCP ni Azure en este proyecto.
- Tiene Docker Desktop instalado en su PC con Windows.
- Prefiere que se le pregunten las decisiones importantes antes de construir, y que se le muestre el plan.

## 2. Qué es PuzzleLove

Web app de rompecabezas multijugador en tiempo real:

- **Sala global** en `/`: todos los que entran sin link juegan el mismo rompecabezas de **5×5**, sin límite de jugadores.
  Solo el admin sube sus imágenes a una cola. Al completarse se muestra la victoria unos 12 segundos y luego
  se carga la siguiente imagen de la cola; si la cola está vacía, **se revuelve la misma imagen**.
- **Salas privadas** en `/r/:slug`: cualquiera sube una imagen en `/new`, elige 24, 48, 96 o 150 piezas y comparte el link.
  Máximo **8 jugadores**. Se borran después de **24 horas sin actividad** (imagen y registro).
- **Admin** en `/admin`: contraseña por variable de entorno, cola de imágenes de la global, botón para pasar a la siguiente.
- Piezas con pestañas clásicas, siempre derechas (sin rotación).
- Ayudas: imagen de referencia y silueta tenue en el tablero.
- Presencia: cursores con nombre y color, lista de jugadores, pieza bloqueada mientras alguien la agarra.
- Animaciones al encajar (glow, destellos), animación de victoria, confeti y ranking de piezas por jugador.
- Sonidos estilo click de madera, **sintetizados con Web Audio API** (no hay archivos de audio).
- Whiteboard con cuadrícula punteada. Interfaz en **español e inglés**. Funciona en celular y escritorio.
- Sin moderación de imágenes por decisión del usuario; solo límite de tamaño y rate limit de creación de salas.

## 3. Estado actual

**Terminado y verificado.** Todo lo de la sección 2 está implementado.

- 12 tests de `shared` y 12 tests de integración de `server` pasan (`npm test`). `npm run typecheck` limpio.
- Prueba end-to-end en navegador (Edge headless con Playwright, script fuera del repo): arrastre real con mouse,
  encaje sincronizado entre dos jugadores, victoria, ranking, rotación de la global, creación de sala privada,
  sala inexistente, admin. Sin errores de consola.
- Persistencia verificada: se mató el servidor sin apagado limpio y el estado se recuperó.
- Build de producción verificado: el servidor sirve el cliente compilado con fallback SPA.
- **No verificado:** audio real (el navegador de prueba no tiene audio) y arrastre táctil en un celular físico.
- **Git:** nada commiteado todavía; todo está sin rastrear. No hay remoto.

Problemas conocidos menores:
- En celular vertical las piezas se ven pequeñas al entrar y hay que hacer zoom.
- `npm audit` reporta vulnerabilidades en herramientas de desarrollo (Prisma CLI, esbuild), no en runtime.

## 4. Stack y estructura

Monorepo con npm workspaces. TypeScript en todo (`typescript ~5.9`).

```
shared/   Lógica pura compartida (sin dependencias de runtime)
server/   Node + Express 5 + Socket.IO 4 + Prisma 6 + PostgreSQL + sharp + @aws-sdk/client-s3
client/   React 19 + Vite 8 + Konva 10 (imperativo, sin react-konva) + react-i18next + canvas-confetti
docs/     Este documento
```

Archivos clave:

| Archivo | Qué hace |
|---|---|
| `shared/src/puzzle/layout.ts` | Tamaño del rompecabezas en unidades de mundo, grid según cantidad de piezas, vecinos |
| `shared/src/puzzle/shapes.ts` | Contornos Bézier deterministas por seed; los bordes internos se generan una vez y se comparten |
| `shared/src/puzzle/state.ts` | Estado de grupos, dispersión inicial, `releaseGroup` (encajes y fusión), detección de victoria |
| `shared/src/events.ts` | Tipos de todos los eventos de Socket.IO cliente/servidor |
| `shared/src/constants.ts` | 5×5 global, 8 jugadores, opciones de piezas, TTL de 24 h, colores |
| `server/src/rooms/RoomManager.ts` | Corazón del multijugador: salas en memoria, bloqueos, ticks, guardado, rotación global, expiración |
| `server/src/sockets.ts` | Conecta eventos de socket con `RoomManager` |
| `server/src/app.ts` | Rutas HTTP: crear sala, servir imágenes, admin, archivos estáticos del cliente |
| `server/src/db/repo.ts` | Interfaz `Repo`; `prismaRepo.ts` para producción y `memoryRepo.ts` para tests |
| `server/src/storage.ts` | `ImageStorage`: `LocalStorage` (disco) y `S3Storage` (MinIO, R2, S3) |
| `server/src/images.ts` | Normaliza uploads con sharp a WebP máx. 2000 px; genera imagen por defecto de la global |
| `server/prisma/schema.prisma` | Modelos `Room` (estado en JSONB) y `GlobalQueueItem` |
| `server/src/server.test.ts` | Tests de integración con Socket.IO real y dos clientes |
| `client/src/game/BoardEngine.ts` | Motor del tablero con Konva: arrastre, zoom/pinch, interpolación, efectos, victoria |
| `client/src/game/pieceRender.ts` | Pre-renderiza cada pieza a un canvas con bisel; glow para efectos |
| `client/src/pages/PlayPage.tsx` | Conecta socket, motor y HUD; encola eventos mientras carga la imagen |
| `client/src/audio/sounds.ts` | Síntesis de sonidos |
| `client/src/i18n.ts` | Textos en español e inglés |

## 5. Cómo funciona el multijugador

- Una partida se define por `imagen + filas + columnas + seed`. Cliente y servidor generan las mismas formas,
  así que por la red solo viajan posiciones.
- Cada grupo de piezas conectadas guarda un desplazamiento `(x, y)`. Una pieza está en `(pieza.x + grupo.x, pieza.y + grupo.y)`.
  Dos grupos encajan si sus desplazamientos están a menos de `layout.tolerance`. Un grupo en `(0, 0)` está sobre el marco.
- El **servidor es autoritativo**: `group:grab` bloquea el grupo, `group:move` se reenvía en lotes cada 50 ms,
  `group:release` decide el encaje con `releaseGroup`, y el servidor emite `group:snapped` o `group:unlocked`.
  Nunca se fusiona un grupo bloqueado por otro jugador.
- Bloqueos expiran a los 30 s sin movimiento y se liberan al desconectarse.
- El estado se guarda en Postgres cada 5 s si cambió, al completar y al recibir SIGINT/SIGTERM.
- Las salas privadas vacías se descargan de memoria tras 2 minutos. La global siempre está en memoria.
- El cliente recibe un snapshot completo al unirse o al empezar un rompecabezas nuevo (`room:snapshot`).

## 6. Cómo correrlo en local

```bash
npm install
cp server/.env.example server/.env    # ya existe un server/.env local con contraseña de admin de desarrollo

# Terminal 1: Postgres embebido en el puerto 5433 (datos en server/.pgdata), sin Docker
npm run db:embedded

# Terminal 2
npm run db:migrate      # primera vez
npm run dev             # cliente en http://localhost:5173, servidor en 3001
```

Alternativa con Docker: `docker compose up -d` levanta Postgres en 5432 y MinIO en 9000 (ver comentarios en `docker-compose.yml`).

Producción: `npm run build`, `npm run db:migrate`, `npm start`.

## 7. Trampas conocidas del entorno (Windows)

- **npm workspaces pierde dependencias:** dos `npm install -w <pkg>` seguidos pueden borrar lo que agregó el primero
  del `package.json`. Verifica el archivo después de instalar.
- **npm 11 bloquea scripts de instalación:** los paquetes aprobados están en `allowScripts` del `package.json` raíz
  (Prisma, esbuild, embedded-postgres). Paquetes nuevos con postinstall necesitan `npm install-scripts approve <pkg>`.
- **Prisma bloquea `migrate reset` cuando lo invoca un agente.** No intentes saltarte ese bloqueo; pide al usuario.
- **Detener tareas en segundo plano no mata procesos hijos en Windows.** Revisa procesos `node`/`postgres` que quedan
  escuchando en 3001, 5173 o 5433. Para apagar el Postgres embebido usa `pg_ctl stop -D server/.pgdata -m fast`
  (binario en `node_modules/@embedded-postgres/windows-x64/native/bin`).
- **`prisma generate` falla si el servidor está corriendo** porque el engine queda bloqueado.
- **No hay Chrome instalado ni se puede descargar Chromium de Playwright** (timeout). Usa Edge:
  `executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'`.
- En modo desarrollo el motor queda expuesto en `window.__engine` para pruebas de navegador.

## 8. Siguiente fase: plataforma de datos (acordada, sin empezar)

Objetivo: cubrir pipeline de datos, dashboard e infraestructura en el VPS.

### Decisiones tomadas
- **Pipeline para 8 GB:** Python + **PySpark en modo local** (`local[2]`, unos 2 GB de driver) por horario, no un cluster.
- **Data lake** en Garage (S3) con capas bronze/silver/gold en Parquet.
- **Warehouse** en Postgres, schema `warehouse`, modelo estrella.
- **Orquestación** con cron en contenedor y una tabla `pipeline_runs`. Sin Airflow por memoria.
- **Dashboard:** propio en React dentro de `/admin` **y** Apache Superset en el VPS.
- **Infra:** Docker Compose de producción con límites de memoria, Traefik con HTTPS y WebSockets, Ansible para aprovisionar,
  GitHub Actions para CI, monitoreo ligero.
- **Backups fuera del VPS en Cloudflare R2** (plan gratis, compatible con S3). El usuario no tiene Azure personal.

### Presupuesto de memoria del VPS
| Servicio | RAM |
|---|---|
| App Node | 300 MB |
| Postgres | 1 GB |
| Garage | 256 MB |
| Superset y Redis | 1.5 GB |
| Spark (solo mientras corre) | 2.5 GB |
| Traefik, monitoreo y sistema | 1.3 GB |

### Trabajo del agente, en orden
1. **Tracking de eventos: HECHO (2026-09-17).** Módulo `server/src/analytics/`:
   - `events.ts`: tipos y payloads, `EVENT_SCHEMA_VERSION = 1`.
   - `sink.ts`: `BufferedEventSink`, que escribe lotes cada 2 s o cada 500 eventos, con buffer acotado a 10 mil (descarta los más viejos) y reintento en el siguiente flush; nunca lanza errores. También `MemoryEventSink` para tests y `NoopEventSink`.
   - `prismaEventStore.ts`: `createMany` con `skipDuplicates`.

   Tabla `analytics_events` (migración `20260917100000_analytics_events`):
   - `id` bigserial, que es el watermark del pipeline.
   - `event_id` uuid único.
   - `event_type`, `schema_version`, `occurred_at`, `ingested_at`.
   - `session_id` (socket), `client_id`, `room_slug`, `room_type`, `puzzle_id` (`slug:seed`) y `payload` jsonb.

   Eventos: `room_created`, `puzzle_started` (source create/restart/queue/reshuffle/default), `player_joined` (con nombre y color, por decisión del usuario),
   `join_failed`, `player_left` (disconnect/switch, duration_ms), `piece_grabbed`, `grab_conflict`, `piece_dropped` (hold_ms, snapped, frame,
   merged_groups, group_size), `piece_abandoned` (left/regrab/timeout), `puzzle_completed` (contributors), `global_rotated` (auto/admin) y `room_expired`.
   `group:move` no se registra. El usuario eligió grab y drop como eventos separados.
2. **Simulador de jugadores: HECHO (2026-09-17).** Workspace `tools/simulator/`:
   - `strategy.ts` (`planMove`): elige grupos (prefiere piezas sueltas) y apunta al marco o a un vecino con probabilidad `skill × progreso`.
   - `behavior.ts`: lognormales para think, hold y sesión; curva horaria en America/Mexico_City con boost de fin de semana.
   - `personas.ts`: 12 bots `🤖 Nombre` con `bot-…` y una población sintética `sim-0001…` con pesos tipo Zipf.
   - **`live.ts`:** bots reales por Socket.IO **en producción**, por decisión del usuario. Servicio `bots` del compose con la misma imagen de la app;
     `BOTS_MAX` (default 2) escalado por la curva horaria; 0 los apaga. Usa unos 25 MB.
   - **`generate.ts` + `backfill.ts`:** historia sintética usando el motor real (`releaseGroup`), determinista por seed. Inserta en lotes con
     `is_synthetic = true` (migración `20260917120000_analytics_events_synthetic`); pide `--yes` y acepta `--purge` y `--dry-run`.
     28 días ≈ 600 mil eventos, unos 4 mil puzzles y 150 jugadores; en local tarda unos 22 s y ocupa unos 257 MB. El usuario decidió que el backfill va **solo en local**.
   - Tests (vitest): orden temporal, determinismo, consistencia de sesiones (join primero, leave al final, cada grab se resuelve) y merges = piezas − 1 por puzzle completado.
   - Para filtrar en el pipeline: `is_synthetic` (backfill) y `client_id LIKE 'bot-%'` (bots en vivo).
3. **Pipeline: HECHO (2026-09-17).** `analytics/`: Python 3.13 con uv, PySpark 4.2 `local[2]` y **Delta Lake 4.4** sobre Java 21.
   Imagen `analytics/Dockerfile` con targets `test` y `runtime` (supercronic 04:30 America/Mexico_City). Los jars (delta, hadoop-aws 3.5.0 con
   awssdk bundle, postgresql 42.7.13) se resuelven al construir (`pipeline/jars.py`), así que en ejecución no se descarga nada. La imagen pesa unos 5.8 GB.
   - `bronze.py`: JDBC incremental `id > watermark`, 4 particiones, append a `s3a://lake/bronze/events` particionado por `ingest_date`;
     antes borra ids mayores al watermark, así que reintentar es idempotente.
   - `silver.py`:
     - `events`: dedup por `event_id` con MERGE; `is_bot`, `is_synthetic`, `event_date`/`hour_local`/`weekday` en hora de México.
     - `moves`: grab → siguiente evento de la sesión (dropped/abandoned/open).
     - `sessions`: join → siguiente leave en la misma sala, con estadísticas de moves.
     - `json_field` castea números vía double: el generador emitía floats, y un cast estricto rompió la primera corrida.
   - `gold.py`: dim_date, dim_player, dim_room, fact_puzzle (traffic_type synthetic/bot/mixed/human/none), fact_session, fact_move,
     agg_daily_activity, agg_daily_puzzles, agg_hourly_heatmap y agg_difficulty (embudo started → played → completed).
     Silver derivado y gold se recalculan completos en cada corrida (volumen chico).
   - `quality.py`: 5 checks error y 2 warn. Si falla uno error, no se publica.
   - `load.py`: JDBC a `warehouse._stg_*` y swap en una transacción (drop, rename, ALTER a timestamptz, PK e índices).
     `createTableColumnTypes` no acepta TIMESTAMPTZ.
   - `runs.py`: `warehouse.pipeline_runs` (status, watermark, row_counts, checks y error); las corridas colgadas quedan en failed.
   - Local con 600 mil eventos: full refresh en unos 100 s; incremental de 55 eventos en unos 99 s. 6 tests de pytest en Docker; CI job `pipeline`.
   - Garage: bucket `lake` con llave propia (`LAKE_ACCESS_KEY_ID`/`LAKE_SECRET_ACCESS_KEY`), que `deploy/garage/init-lake.sh` importa de forma idempotente.
4. **Dashboard propio:** pestaña de analítica en `client/src/pages/AdminPage.tsx` con endpoint `/api/admin/analytics`.
5. **Superset** configurado con conexión al warehouse y dashboard exportado como código.
6. **Infra:** Dockerfiles, `deploy/docker-compose.prod.yml`, Traefik, playbook de Ansible, GitHub Actions,
   backups `pg_dump` y Garage a R2, monitoreo.
7. **Documento de arquitectura** con diagrama, decisiones (ADRs) y runbook.

Todo se prueba localmente con Docker antes del VPS.

### Trabajo del usuario
- Ubuntu 24.04 en el VPS, llave SSH, dominio con subdominios para la app y Superset.
- Correr el playbook de Ansible desde su PC y llenar el `.env` de producción.
- Crear bucket en Cloudflare R2 para backups y poner las llaves en el `.env`.
- Crear repo en GitHub (idealmente público para el CV), primer deploy, usuario admin de Superset.
- Probar una restauración de backup.

### Limitación honesta para el CV
El VPS cubre contenedores, almacenamiento de objetos, redes, seguridad y operación. No demuestra infraestructura
multi-tenant real, ML distribuido ni Hadoop; esas partes se apoyan en la experiencia laboral del usuario con Azure
o se presentan como conocimiento, no como experiencia.

## 9. VPS y despliegue (en curso)

VPS de Hostinger: Ubuntu 24.04, 8 GB, dominio `luisjgl.cloud` (DNS en Hostinger; registros A `@`, `traefik`, `minio`, `superset`).

**Hecho en el VPS (manual, guiado):** usuario `luis` con sudo y llave SSH; `00-hardening.conf` (sin root, sin contraseñas,
`AllowUsers luis`); UFW (22 limit, 80, 443) + firewall de hPanel; fail2ban (sshd); unattended-upgrades; swap 4 GB;
Docker CE + Compose con `log-driver local` y `live-restore`.

**Decisiones:**
- **Traefik** en lugar de Nginx. Let's Encrypt HTTP-01, empezar en staging.
- **Garage** en lugar de MinIO: MinIO dejó de publicar imágenes comunitarias. `--single-node --default-bucket` crea la llave y el bucket.
  El `docker-compose.yml` de desarrollo sigue con MinIO (compatible S3).
- **Sin réplicas ni balanceo:** el estado del juego vive en memoria de `RoomManager`.
- **Sin Watchtower:** CI/CD push con GitHub Actions (GHCR + SSH + migrate + health check + rollback).
- Aprovisionamiento híbrido: pasos manuales primero; después playbook de Ansible.

**Stack en `deploy/`:** `docker-compose.prod.yml` (socket-proxy, traefik, postgres, garage, migrate, app),
`docker-compose.local.yml` (override para Docker Desktop en `https://puzzlelove.localhost`), `traefik/dynamic/middlewares.yml`,
`garage/garage.toml`, `.env.example`. `Dockerfile` en la raíz con targets `runtime` y `migrate`.
Probado en local: HTTPS, redirección, headers, auth del dashboard, WebSocket, subida a Garage, cookie `Secure`, persistencia al reiniciar.
Solo Traefik publica puertos (Docker se salta UFW).

**CI/CD:** `.github/workflows/ci.yml` (PR: typecheck y tests) y `deploy.yml` (push a `main`: tests → imágenes a GHCR
`sha-xxxxxxx` → rsync de `deploy/` a `/opt/puzzlelove` → `deploy/deploy.sh`, que aplica migraciones, hace `up --wait`, verifica la salud
vía Traefik y hace rollback automático). Deploy y rollback ensayados en local con `COMPOSE_EXTRA=docker-compose.local.yml`.
Operación y primera instalación en `docs/runbook.md`.

**En producción desde 2026-09-17:** repo `github.com/LUISJG57/PuzzleLove` (público), environment `production` con secrets
`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (llave `puzzlelove_actions`) y `VPS_KNOWN_HOSTS`. Imágenes públicas en GHCR
(`ghcr.io/luisjg57/puzzlelove`). Certificados de Let's Encrypt de producción para `luisjgl.cloud` y `traefik.luisjgl.cloud`.
El `.env` y `traefik/users` solo existen en `/opt/puzzlelove` en el VPS.

**Backups (en producción; primer backup y test-restore real el 2026-09-17):** servicio `backup` (`deploy/backup/`: postgres:17-alpine + rclone +
age + supercronic). Corre diario a las 03:30 America/Mexico_City: `pg_dump` y tar de Garage cifrados con age → R2, con retención de 30 días.
`deploy/restore.sh test|prod` recibe la llave privada de age por stdin (nunca vive en el VPS). En local, R2 se simula con un segundo bucket de Garage.

**Deploy por tag (desde el pipeline de datos):** `IMAGE_REPO=ghcr.io/luisjg57/ ./deploy.sh sha-xxxxxxx` despliega las 4 imágenes
(`puzzlelove`, `-migrate`, `-backup` y `-pipeline`) con el mismo tag. La release activa queda en `.deployed-release` (`repo tag`), y el formato viejo `.deployed-images`
se lee para el rollback. `./deploy.sh` sin argumentos vuelve a aplicar la release actual.

R2: bucket `puzzlelove-backups` con token limitado a ese bucket. Llave privada de age en `%USERPROFILE%\.age\puzzlelove-backup.key`
en la PC del usuario (y en su gestor de contraseñas).

**Monitoreo (en producción desde 2026-09-17):** servicio `uptime-kuma` (2.5.5-slim-rootless, SQLite vía `UPTIME_KUMA_DB_TYPE`)
en `status.$DOMAIN`. El admin está detrás de `dashboard-auth`; las rutas `/status/`, `/api/status-page/` y `/assets/` son públicas.
Está en las redes proxy, internal y socket para chequear la app, Postgres, Garage y los contenedores. El backup le avisa por `BACKUP_PING_URL`
(push interno). Alertas a Discord; UptimeRobot externo cubre la caída total del VPS. Monitores listados en `docs/runbook.md`.

Configurado por el usuario: admin de Kuma, webhook de Discord, monitores (app, sitio público, Postgres, push del backup y otros),
página pública `https://status.luisjgl.cloud/status/puzzlelove` y UptimeRobot externo. `BACKUP_PING_URL` está en el `.env` del VPS.

**Ansible (aplicado al VPS el 2026-09-17; la simulación posterior dio `changed=0`):** `deploy/ansible/` con los roles base, users, ssh, firewall, fail2ban, swap, docker y app.
Toolchain fijo en Docker (`ansible==14.4.0`, `ansible-lint==26.8.0`); `run.ps1` monta `~/.ssh` y fija `ANSIBLE_CONFIG`, porque
Ansible ignora `ansible.cfg` en directorios de Windows montados (world-writable). `test/run.sh` usa un contenedor systemd privilegiado,
aplica dos corridas y exige `changed=0`; la swap se salta con `swap_enabled: false`. CI corre `ansible-lint` (perfil production).
rsync del deploy excluye `ansible/`.

La primera simulación detectó diferencias reales: faltaban la línea de swap en `/etc/fstab` y `99-swap.conf`, porque los comandos manuales
no se ejecutaron. Ansible las corrigió. Ejecución en Windows: `powershell -ExecutionPolicy Bypass -File .\deploy\ansible\run.ps1`.
un.ps1`.

**Infraestructura terminada.** Siguiente: la plataforma de datos (sección 8).

## 10. Reglas para el agente

- Nunca pedir ni escribir secretos en el chat; van en `.env` (ignorado por git).
- No commitear ni hacer push sin que el usuario lo pida.
- No borrar datos de la base local del usuario sin confirmar, salvo datos de prueba creados por el propio agente.
- Mantener textos de interfaz en español e inglés al agregar pantallas.
- Correr `npm test` y `npm run typecheck` antes de reportar que algo está terminado.
