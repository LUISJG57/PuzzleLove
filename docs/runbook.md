# PuzzleLove — Runbook de producción

VPS Ubuntu 24.04 en Hostinger · dominio `luisjgl.cloud` · stack en `/opt/puzzlelove` (copiado desde `deploy/` por el pipeline).

## Arquitectura

```
Internet ──► firewall hPanel ──► UFW (22, 80, 443)
                                   │
                         Traefik :80/:443  (Let's Encrypt, headers, rate limit)
                            │            └── socket-proxy ──► docker.sock (solo lectura)
                  red proxy │
                           app (Node + Socket.IO)
                 red internal │
                  ┌───────────┴───────────┐
               Postgres 17            Garage (S3)
                  └───────── backup ──────┘ ──(age)──► Cloudflare R2
                           uptime-kuma (status.) ──► Discord      UptimeRobot (externo) ──► Discord
```

Solo Traefik publica puertos. Docker se salta UFW, así que ningún otro servicio debe usar `ports:`.

## Deploy

Es automático: cada push a `main` corre `.github/workflows/deploy.yml`.

1. **`test`:** typecheck y tests.
2. **`images`:** construye y sube `ghcr.io/<owner>/puzzlelove`, `puzzlelove-migrate` y `puzzlelove-backup` con el tag `sha-xxxxxxx`.
3. **`deploy`:**
   - Hace `rsync` de `deploy/` al VPS.
   - Corre `deploy.sh <app-image> <migrate-image> <backup-image>`, que hace pull, aplica las migraciones y ejecuta `up --wait`.
   - Verifica `/api/health` a través de Traefik. Si falla, vuelve a la release anterior y el job queda en rojo.

La release activa se guarda en `/opt/puzzlelove/.deployed-images`.

**Las migraciones no se revierten.** Toda migración debe ser compatible con la versión anterior de la app: primero se agregan columnas y en un deploy posterior se borran las viejas.

## Comandos habituales (en el VPS)

```bash
cd /opt/puzzlelove
alias dc='docker compose -f docker-compose.prod.yml --env-file .env'

dc ps                          # estado y health
dc logs -f --tail 100 app      # logs de la app
dc logs traefik | grep -v RequestMethod   # errores de Traefik o ACME
docker stats --no-stream       # memoria

# Volver a aplicar la release activa (p. ej. tras cambiar .env). No uses `dc up -d` sin imágenes:
./deploy.sh $(cat .deployed-images)
```

### Rollback manual a una release concreta
```bash
./deploy.sh ghcr.io/<owner>/puzzlelove:sha-abc1234 ghcr.io/<owner>/puzzlelove-migrate:sha-abc1234 ghcr.io/<owner>/puzzlelove-backup:sha-abc1234
```
También se puede relanzar un deploy anterior desde GitHub → Actions → Deploy → *Re-run jobs*.

## Aprovisionar con Ansible

`deploy/ansible/` reproduce en código el endurecimiento del servidor:

| Rol | Qué hace |
|---|---|
| `base` | paquetes base y actualizaciones de seguridad automáticas |
| `users` | usuario `luis` con sudo y llaves SSH autorizadas (`group_vars/vps.yml`) |
| `ssh` | `00-hardening.conf`: sin root, sin contraseñas, `AllowUsers`; valida con `sshd -t` antes de aplicar |
| `firewall` | UFW: deny por defecto, SSH con límite de intentos, 80 y 443 |
| `fail2ban` | jail de sshd con backend systemd |
| `swap` | 4 GB de swap y `vm.swappiness=10` |
| `docker` | Docker CE + Compose, `daemon.json` con rotación de logs y `live-restore` |
| `app` | `/opt/puzzlelove` y un aviso si faltan `.env` o `traefik/users` |

Corre desde Windows con Docker, sin instalar Ansible. Pide la contraseña de sudo de `luis`:
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\ansible\run.ps1 --check --diff   # simulación
powershell -ExecutionPolicy Bypass -File .\deploy\ansible\run.ps1                   # aplicar
```

**Servidor nuevo:**
1. Crea el VPS con Ubuntu 24.04 y tu llave SSH.
2. Como root, crea `luis` con contraseña y sudo, y copia la llave a `~luis/.ssh/authorized_keys`.
3. Cambia la IP en `inventory.yml` y corre `run.ps1`.
4. Crea `.env` y `traefik/users`, actualiza los secrets `VPS_HOST` y `VPS_KNOWN_HOSTS` en GitHub y relanza el deploy.
5. Restaura con `restore.sh prod latest --yes`.

**Prueba de idempotencia (local):** `bash deploy/ansible/test/run.sh` levanta un Ubuntu 24.04 con systemd en Docker,
aplica el playbook dos veces y falla si la segunda corrida cambia algo. CI corre `ansible-lint` en cada PR.

## Primera instalación (una sola vez)

```bash
sudo install -d -o luis -g luis /opt/puzzlelove
sudo apt install -y rsync
```

1. Copia `deploy/.env.example` a `/opt/puzzlelove/.env`, llena los valores y corre `chmod 600 .env`.
   - Deja `ACME_CA_SERVER` en staging.
   - Borra `APP_IMAGE` y `MIGRATE_IMAGE`: el deploy los define.
2. Crea `traefik/users`:
   `docker run --rm httpd:2.4-alpine htpasswd -nbB admin 'contraseña' > /opt/puzzlelove/traefik/users`
3. Configura la llave de deploy y los secrets de GitHub (environment `production`):

   | Secret | Valor |
   |---|---|
   | `VPS_HOST` | IP del VPS |
   | `VPS_USER` | `luis` |
   | `VPS_SSH_KEY` | llave privada ed25519 creada solo para Actions (su `.pub` va en `~luis/.ssh/authorized_keys`) |
   | `VPS_KNOWN_HOSTS` | salida de `ssh-keyscan -t ed25519 <IP>` |

4. Después del primer deploy, en GitHub → Packages, marca `puzzlelove` y `puzzlelove-migrate` como **públicos**. Así el VPS descarga las imágenes sin tener que hacer login.

### Pasar de Let's Encrypt staging a producción
Cuando `https://luisjgl.cloud` ya responde con el certificado de staging (no confiable):
```bash
sed -i 's#^ACME_CA_SERVER=.*#ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory#' .env
dc stop traefik && dc rm -f traefik && docker volume rm puzzlelove_letsencrypt
dc up -d traefik
```
La renovación es automática: Traefik renueva cada certificado 30 días antes de que venza.

## Backups

El servicio `backup` corre todos los días a las **03:30 (America/Mexico_City)**:
1. Hace `pg_dump -Fc` de Postgres y un `tar` de todas las imágenes del bucket de Garage.
2. Cifra ambos archivos con **age** usando la llave pública `BACKUP_AGE_RECIPIENT`.
3. Los sube a R2:
   - `postgres/AAAA/MM/puzzlelove-<stamp>.dump.age`
   - `garage/AAAA/MM/images-<stamp>.tar.age`
4. Borra los archivos con más de **30 días**.

**La llave privada de age no está en el servidor.** Guárdala en tu gestor de contraseñas y en tu PC.
Si se pierde, los backups no se pueden leer.

```bash
dc exec backup backup.sh run      # backup manual inmediato
dc exec backup backup.sh list     # listar lo que hay en R2
dc logs --tail 50 backup          # resultado de la última corrida
```

### Probar una restauración (sin tocar producción)
Desde tu PC en PowerShell. La llave privada viaja por stdin y no se escribe en el disco del VPS:
```powershell
Get-Content "$env:USERPROFILE\.age\puzzlelove-backup.key" | ssh luis@2.25.230.57 "bash /opt/puzzlelove/restore.sh test"
```
El comando descarga el último backup, lo restaura en un Postgres temporal dentro del contenedor y muestra el conteo de filas y de imágenes.
Hazlo al menos una vez al mes.

### Restaurar producción
Detiene la app, restaura Postgres (`--clean`) y copia las imágenes de vuelta a Garage. Luego vuelve a levantar la app.
```powershell
Get-Content "$env:USERPROFILE\.age\puzzlelove-backup.key" | ssh luis@2.25.230.57 "bash /opt/puzzlelove/restore.sh prod latest --yes"
```
Para una fecha concreta, usa el stamp en lugar de `latest`, por ejemplo `20260918T093000Z`. Los stamps se ven con `restore.sh list`.

## Monitoreo

**Uptime Kuma** en `https://status.luisjgl.cloud`. El admin tiene dos capas: la basic auth de Traefik (`traefik/users`) y el login propio de Kuma.
La página pública `https://status.luisjgl.cloud/status/puzzlelove` no pide contraseña.
Las alertas llegan a **Discord** por webhook, que se configura en Kuma → Settings → Notifications.

| Monitor | Tipo | Destino | Qué detecta |
|---|---|---|---|
| App (interno) | HTTP | `http://app:3001/api/health` | la app no responde |
| Sitio público | HTTP | `https://luisjgl.cloud/api/health` (avisa si el certificado vence pronto) | Traefik, TLS o certificado |
| Postgres | TCP | `postgres:5432` | base de datos caída |
| Garage | TCP | `garage:3900` | almacenamiento caído |
| Contenedores | Docker | host `tcp://socket-proxy:2375` | contenedor detenido o reiniciándose |
| Backup diario | Push | intervalo de 25 h; URL en `BACKUP_PING_URL` | el backup no corrió o falló |

Como Kuma corre en el mismo VPS, no puede avisar si se cae la máquina entera. Para eso existe un monitor externo en
**UptimeRobot** (plan gratis) sobre `https://luisjgl.cloud/api/health`, que también alerta a Discord.

## Bots y datos sintéticos

**Bots en vivo:** el servicio `bots` juega la sala global con nombres `🤖 …` (`client_id` `bot-…`). La cantidad sigue la curva
horaria de México hasta `BOTS_MAX` (default 2). Para apagarlos, pon `BOTS_MAX=0` en `.env` y corre `./deploy.sh $(cat .deployed-images)`.

**Backfill (solo en local):** genera semanas de historia en `analytics_events` con `is_synthetic = true`:
```bash
cd deploy
PW=$(grep ^POSTGRES_PASSWORD .env | cut -d= -f2)
docker run --rm --network puzzlelove_internal -e DATABASE_URL="postgresql://puzzlelove:$PW@postgres:5432/puzzlelove" \
  puzzlelove:local node tools/simulator/dist/backfill.js --days 28 --seed 42 --purge --yes
```
`--dry-run` solo muestra el resumen. `--purge` borra antes los sintéticos previos, así que se puede correr varias veces.

## Ensayo local del deploy (Docker Desktop)
```bash
cd deploy
COMPOSE_EXTRA=docker-compose.local.yml bash deploy.sh puzzlelove:local puzzlelove-migrate:local puzzlelove-backup:local
```

## Problemas conocidos
- **`dashboard-auth` falla:** falta `traefik/users`. Si Docker lo creó como carpeta vacía, bórrala y crea el archivo.
- **Certificado no emitido:** revisa que el registro A apunte al VPS, que el puerto 80 esté abierto en UFW y en hPanel, y lee los logs de Traefik.
- **Garage:** la llave (`S3_ACCESS_KEY_ID`) debe tener el formato `GK` + 32 caracteres hex. No cambies la llave en `.env` después del primer arranque sin revisar con `docker exec puzzlelove-garage-1 /garage key list` que la nueva exista.
