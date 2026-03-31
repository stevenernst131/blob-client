# Embr Blob Client

A minimal sample app that demonstrates Embr's blob storage data-plane API.
Upload, preview, and manage static content (images, text, anything) stored in
your environment's blob store — no SDK required.

## What it does

| Feature | How |
|---------|-----|
| **List blobs** | `GET /api/blobs` → proxied to `GET /_embr/blob/` with Bearer key |
| **Upload / update** | File picker + blob key → `POST /api/blobs/:key` → `PUT /_embr/blob/:key` |
| **Smart preview** | `image/*` rendered inline, `text/*` / JSON / XML shown in a code block, others offered as a download |
| **Download** | Direct public link to `/_embr/blob/:key` (no auth needed for reads) |
| **Delete** | `DELETE /api/blobs/:key` → `DELETE /_embr/blob/:key` |

## Architecture

```
Browser
  ├─ public reads:  GET /_embr/blob/{key}  → Yarp (no auth) → Azure Blob
  └─ mutations:     /api/blobs/*           → Express proxy  → /_embr/blob/* (Bearer)
```

The Express backend keeps `EMBR_BLOB_KEY` server-side and proxies authenticated
operations to the Embr data plane. Public downloads go straight through Yarp —
no proxy round-trip.

## Deploy to Embr

1. Push this folder to a GitHub repository.
2. Deploy with the Embr CLI:
   ```bash
   embr quickstart deploy <owner/repo> -i <installation_id>
   ```
3. Embr automatically injects `EMBR_BLOB_KEY` into the environment.
4. Open your environment URL — the app is ready to use.

> The blob store is auto-provisioned when the environment is created. If it
> isn't ready yet, provision it from the Embr Portal (Storage page) or via the
> control-plane API.

## Run locally

```bash
cd SampleApps/blob-client
npm install
```

Copy the example env file and fill in your blob key:

```bash
cp .env.example .env
# Edit .env → set EMBR_BLOB_KEY to your environment's API key
```

Start the server:

```bash
node server.js          # or: npm start
```

Open <http://localhost:3000>.

> **Note:** Locally there is no Yarp proxy, so `/_embr/blob/*` requests will
> 404. The list/upload/delete operations go through the Express proxy which
> calls back to the public Embr URL. For full end-to-end testing, deploy to
> Embr.

## Backend proxy endpoints

| Method | Path | Proxied to | Auth |
|--------|------|------------|------|
| `GET` | `/api/blobs?prefix=&pageSize=&continuationToken=` | `GET /_embr/blob/?…` | Bearer |
| `POST` | `/api/blobs/:key` | `PUT /_embr/blob/:key` | Bearer |
| `DELETE` | `/api/blobs/:key` | `DELETE /_embr/blob/:key` | Bearer |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EMBR_BLOB_KEY` | Yes | API key for the environment's blob store. Injected by Embr at runtime. |
| `PORT` | No | Server port (default: `3000`). |

## Project structure

```
blob-client/
├── server.js          # Express backend — static files + blob proxy
├── public/
│   └── index.html     # Single-page frontend (vanilla HTML/JS/CSS)
├── package.json
├── .env.example
├── .gitignore
└── README.md
```
