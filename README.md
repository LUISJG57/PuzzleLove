# PuzzleLove 🧩

Rompecabezas multijugador en tiempo real. Sube una imagen, se corta en piezas con pestañas clásicas y se arma en un whiteboard, solo o con amigos.

- **Sala global** en `/`: todos los que entran sin link juegan el mismo rompecabezas de 5×5. Solo el admin sube sus imágenes. Al terminar pasa a la siguiente imagen de la cola, o revuelve la misma si la cola está vacía.
- **Salas privadas** en `/r/:slug`: cualquiera sube una imagen en `/new`, elige 24, 48, 96 o 150 piezas y comparte el link. Máximo 8 jugadores. Se borran tras 24 horas sin actividad.
- **Admin** en `/admin`: cola de imágenes para la global y botón para pasar a la siguiente.

## Stack

| Parte | Tecnología |
|---|---|
| `client/` | React 19, Vite, Konva, Socket.IO client, react-i18next, canvas-confetti |
| `server/` | Node, Express 5, Socket.IO, Prisma 6 + PostgreSQL, sharp, S3 SDK |
| `shared/` | Lógica pura compartida: generación de piezas, encajes y tipos de eventos |

Los sonidos se sintetizan con Web Audio API, así que no hay archivos de audio que licenciar.

## Desarrollo local sin Docker

```bash
npm install
cp server/.env.example server/.env      # y cambia ADMIN_PASSWORD y SESSION_SECRET

# Terminal 1: PostgreSQL embebido en el puerto 5433 (datos en server/.pgdata)
npm run db:embedded

# Terminal 2: aplica migraciones la primera vez y arranca todo
npm run db:migrate
npm run dev
```

Abre http://localhost:5173. Para probar desde tu celular en la misma red, usa la dirección "Network" que imprime Vite.

Con `STORAGE_DRIVER=local` las imágenes se guardan en `server/data/uploads`.

## Desarrollo con Docker

```bash
docker compose up -d
```

Levanta PostgreSQL en el puerto 5432 y MinIO en el 9000 con el bucket `puzzlelove`. Ajusta `server/.env` según el comentario al inicio de `docker-compose.yml`.

## Tests

```bash
npm test          # lógica de piezas y tests de integración del servidor con Socket.IO real
npm run typecheck
```

## Producción (VPS)

```bash
npm ci
npm run build                 # compila client/dist y server/dist
npm run db:migrate
npm start                     # sirve la API, los sockets y el cliente en PORT
```

Notas para el VPS:

- Pon Nginx delante con soporte de WebSockets para `/socket.io/` (`proxy_http_version 1.1`, cabeceras `Upgrade` y `Connection`) y HTTPS.
- Usa `TRUST_PROXY=1` detrás de Nginx para que el límite de creación de salas vea la IP real.
- Mantén el proceso vivo con PM2 o systemd. El servidor guarda el estado de las salas al recibir SIGINT o SIGTERM.
- Para imágenes puedes usar Cloudflare R2 o MinIO con `STORAGE_DRIVER=s3`.
- Corre una sola instancia. Para varias haría falta el adapter de Redis de Socket.IO.

## Cómo funciona

- Una partida se define por imagen, filas, columnas y `seed`. Cliente y servidor generan las mismas formas a partir del seed, así que por la red solo viajan posiciones.
- Cada grupo de piezas conectadas guarda un desplazamiento. Dos grupos encajan cuando sus desplazamientos están a menos de la tolerancia, y un grupo en `(0, 0)` está exactamente sobre el marco.
- El servidor es la autoridad. Bloquea el grupo que alguien agarra, reenvía movimientos en lotes cada 50 ms, decide los encajes y detecta la victoria.
- El estado se guarda en PostgreSQL cada 5 segundos si cambió, en cada victoria y al apagar el servidor.
