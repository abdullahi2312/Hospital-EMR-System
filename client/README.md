# Hospital EMR frontend

This is an isolated React/Vite client. The backend remains at the repository root and runs separately.

## Run locally

Start the backend from the repository root with its configured development environment:

```powershell
npm run dev
```

Then start the frontend:

```powershell
cd client
npm install
npm run dev
```

Vite serves the client at `http://127.0.0.1:5173` and proxies `/api` to `http://127.0.0.1:5000`. Set `VITE_API_BASE_URL` only when the API is hosted at a different URL or path. Vite-exposed variables are public configuration and must never contain credentials or secrets.

## Checks

```powershell
npm run lint
npm run build
```

The client includes role-specific admin, receptionist, doctor, laboratory, pharmacist, and patient workflows. Backend authorization remains authoritative. See the root README, `docs/ARCHITECTURE.md`, `docs/API.md`, and `docs/DEMO_GUIDE.md` for project scope and safe demo instructions. Browser workflows were not verified in the recorded Phase 12 run.
