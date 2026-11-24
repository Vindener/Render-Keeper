# render-keeper

Маленький сервіс, який у заданому вікні часу не дає заснути бекенду на безкоштовному плані
[Render](https://render.com) (free-інстанс засинає після 15 хв без запитів, холодний старт ~20–30 с):

1. **будить бекенд** — `GET <BACKEND_URL><HEALTH_PATH>` кожні `TICK_MIN` хв (за замовч. 10),
   з повторами крізь холодний старт;
2. **опційно запускає синхронізацію** — `POST <BACKEND_URL>/google/sync` із заголовком
   `X-Sync-Secret` кожні `SYNC_EVERY_MIN` хв (і на першому тіку вікна). Без `SYNC_SECRET` — лише пробудження.

Поза вікном нічого не робить, щоб не витрачати 750 безкоштовних інстанс-годин Render на місяць.

Логіка без залежностей (`fetch` + `Intl`), один код для трьох способів запуску:

| Середовище | Точка входу | Коли брати |
|---|---|---|
| **Cloudflare Worker** (рекомендовано) | `src/worker.mjs` | безкоштовно, не спить, cron з точністю до хвилини |
| Docker | `Dockerfile`, `docker-compose.yml` | є домашній сервер / ПК, що завжди увімкнений; кілька бекендів |
| Node ≥ 22 | `bin/keeper.mjs` | є VPS / Raspberry Pi із cron або systemd |

## Налаштування

| Змінна | За замовч. | Що це |
|---|---|---|
| `BACKEND_URL` | — (обовʼязково) | база API, напр. `https://<your-app>.onrender.com/api` |
| `HEALTH_PATH` | `/health?db=1` | шлях пробудження, дописується до `BACKEND_URL`; живим вважається будь-який 2xx, якщо тіло не `{"ok": false}` |
| `SYNC_SECRET` | — | секрет для `X-Sync-Secret` (на бекенді — те саме значення); без нього — лише пробудження |
| `TIMEZONE` | `Europe/Kyiv` | за цим годинником рахується вікно (літній/зимовий час враховано) |
| `ACTIVE_HOURS` | `08:00-22:00` | вікно, кінець не включно; можна через північ (`22:00-02:00`), цілодобово — `00:00-24:00` |
| `ACTIVE_DAYS` | `1-7` | ISO-дні (1 = Пн … 7 = Нд): `1-5`, `1-5,7` |
| `TICK_MIN` | `10` | крок cron (має збігатися з `crons` у `wrangler.toml`); має бути < 15, бо Render засинає після 15 хв |
| `SYNC_EVERY_MIN` | `30` | ритм синхронізації, кратний `TICK_MIN`; `0` — вимкнути |
| `WAKE_BUDGET_MS` | `120000` | скільки максимум чекати пробудження |
| `WAKE_ATTEMPT_TIMEOUT_MS` | `45000` | таймаут одного запиту health |
| `SYNC_TIMEOUT_MS` | `90000` | таймаут запиту синхронізації |

**Ліміт Render:** 750 безкоштовних годин рахуються на весь акаунт. Один сервіс, активний
14 год/день, — ~420 год/міс; два такі — ~840, більше за ліміт. Тоді звужуйте вікна.

## Розгортання на Cloudflare Workers (безкоштовний план)

1. Акаунт на <https://dash.cloudflare.com> (безкоштовний), потім локально:
   ```bash
   npx wrangler@4 login
   ```
2. Перевірити `[vars]` у `wrangler.toml` (вікно, часовий пояс, ритм).
3. Адресу бекенду й секрет задати як секрети Worker'а — так вони не потрапляють у git:
   ```bash
   npx wrangler@4 secret put BACKEND_URL    # https://<your-app>.onrender.com/api
   npx wrangler@4 secret put SYNC_SECRET    # необовʼязково
   ```
   Згенерувати секрет: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. ```bash
   npx wrangler@4 deploy
   ```
5. Перевірка:
   - `GET https://render-keeper.<subdomain>.workers.dev/` — статус: чи відкрите вікно зараз, налаштування (без секрету);
   - ручний тік поза розкладом:
     ```bash
     curl -X POST -H "X-Sync-Secret: <секрет>" https://render-keeper.<subdomain>.workers.dev/run
     ```
     відповідь 200 з `"ok": true`, `wake.ok`, `sync.accounts`;
   - Cloudflare → Workers → `render-keeper` → **Logs**: кожен тік пише JSON-звіт; невдалий тік
     (бекенд не прокинувся, секрет не прийнято, помилка синхронізації) позначається як помилка.
6. Якщо вже налаштовано пінг через cron-job.org / UptimeRobot — вимкнути його, щоб не дублювати.

Для другого бекенду — окремий Worker: скопіювати `wrangler.toml`, змінити `name` і задеплоїти
з `--config`.

Локально без деплою: покласти `BACKEND_URL=...` у `.dev.vars`, запустити
`npx wrangler@4 dev --test-scheduled`, потім
`curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"`.

## Docker (власний ПК / домашній сервер)

Образ без залежностей (~50 МБ, `node:22-alpine`), працює від користувача `node`, вхідні порти
не потрібні — лише вихідний HTTPS до бекенду.

```bash
cp .env.example .env                        # BACKEND_URL, за потреби SYNC_SECRET
docker compose run --rm keeper --dry-run    # перевірити налаштування, без запитів
docker compose up -d --build keeper         # запустити постійно (restart: unless-stopped)
docker compose logs -f keeper               # JSON-звіт кожного тіку
docker compose ps                           # STATUS: healthy / unhealthy
```

- `HEALTHCHECK`: після кожного тіку цикл оновлює heartbeat-файл; якщо він старший за
  2 × `TICK_MIN` + 5 хв — контейнер `unhealthy` (цикл завис).
- `restart: unless-stopped` — контейнер стартує разом з Docker після перезавантаження машини
  (Docker має бути в автозапуску: `sudo systemctl enable docker`).
- **Машина має бути увімкнена й не спати у вікні** — інакше пінгів не буде і Render засне.
  Для ноутбука чи ПК, що засинає, надійніший Cloudflare Worker.
- Ручний тік поза розкладом: `docker compose run --rm keeper --force`.
- Оновлення після змін коду: `docker compose up -d --build`.

### Кілька бекендів

Кожен бекенд — окремий сервіс у `docker-compose.yml` з тим самим образом і своїм env-файлом.
Приклад уже є — `keeper-2` (лише пробудження, без синхронізації):

```bash
cp .env.2.example .env.2
docker compose run --rm keeper-2 --dry-run
docker compose up -d --build keeper-2
docker compose logs -f keeper-2
```

Ще один бекенд — ще один такий блок зі своїм `container_name` і `env_file`.

## Node (VPS, cron, systemd)

```bash
cp .env.example .env                            # заповнити BACKEND_URL
node --env-file=.env bin/keeper.mjs --dry-run   # що зробив би зараз, без запитів
node --env-file=.env bin/keeper.mjs --force     # пробудження + синхронізація просто зараз
```

- **cron** (рекомендовано): `*/10 * * * * cd /opt/render-keeper && node --env-file=.env bin/keeper.mjs >> keeper.log 2>&1`
  — кожен запуск — один тік; вікно рахується в коді.
- **постійний процес**: `node --env-file=.env bin/keeper.mjs --loop` (systemd / pm2),
  тікає кожні `TICK_MIN` хв, вирівняно за годинником; зупиняється по SIGTERM.

Коди виходу: `0` — усе гаразд (або поза вікном), `1` — тік потребує уваги (див. JSON у stdout),
`2` — помилка конфігурації.

## Тести

```bash
npm test      # unit: вікно, DST, ретраї, ритм, Worker-entry
```
