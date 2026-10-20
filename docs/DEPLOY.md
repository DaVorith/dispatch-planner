# Deploying

The app is one Node process: it serves the screens, the API, and refreshes loads
on a timer. It needs a Postgres database. Any host that runs a Docker container
works (Render, Railway, Fly.io, a VPS). Use the provider's managed Postgres.

## Steps

1. Create a Postgres database on the host and copy its connection string.
2. Create a web service from this repository using the `Dockerfile`.
3. Set the environment variables below in the host's settings (never in the repo).
4. Deploy. The database tables are created automatically on first start.
5. Open the site, create the company account, add dispatchers from the Team tab,
   then set `ALLOW_SIGNUP=false` and redeploy so strangers can't sign up.

Run **one instance only**. The refresh timer runs inside the process; two copies
would both search the load board and double the API usage.

## Environment variables

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes, in production | – | Postgres connection string. Without it, data goes to an embedded database in `PGLITE_DIR` (fine on a laptop, not on a host). |
| `NODE_ENV` | | `production` in the image | Sign-in cookies are HTTPS-only in production. |
| `PORT` | | `8080` | Port the server listens on. |
| `ALLOW_SIGNUP` | | `true` | Whether anyone can create a company account. |
| `SESSION_DAYS` | | `14` | How long a sign-in lasts. |
| `REFRESH_SECONDS` | | `120` | Time between load refreshes per company. |
| `MAX_SEARCHES_PER_CYCLE` | | `40` | Cap on load-board searches per company per refresh (keeps within the provider's rate limits). |
| `LOAD_SOURCE` | | `synthetic` | `synthetic` = sample loads. Set to `dat` only after DAT approves access in writing. |
| `DAT_API_BASE`, `DAT_CLIENT_ID`, `DAT_CLIENT_SECRET`, `DAT_USERNAME` | when `LOAD_SOURCE=dat` | – | Credentials DAT issues. The server refuses to start with `dat` if they are missing. |

## Switching to DAT

`server/loads/dat.ts` holds the DAT adapter. Its endpoints and field names are
placeholders until DAT shares the API documentation; that file is the only one
that should need changing. Then set the `DAT_*` variables and `LOAD_SOURCE=dat`.

## Running locally

```
npm install
npm run dev:server   # API on :8080 (embedded database in .data/)
npm run dev          # screens on :5173, talking to the API
```

`npm run build && npm start` runs the production build on :8080.
