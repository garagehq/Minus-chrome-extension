# Deploying the Minus ingest server (Fly.io)

This server receives opted-in, anonymized ad snapshots from the extension and
pushes them to your **private** Hugging Face dataset. The HF write token lives
only here — never in the extension.

## What you provide
1. A private HF dataset: `GarageCyril/minus-web-captures` (create it: huggingface.co → New → Dataset → Owner `GarageCyril`, **Private**).
2. A **fine-grained** HF token with **write access to just that dataset** (Settings → Access Tokens → Fine-grained → add the repo, check Write).
3. A random ingest key: `openssl rand -hex 24`.

Don't paste the token anywhere in git — you set it with `fly secrets` below.

## One-time deploy
```bash
# install flyctl + sign in
curl -L https://fly.io/install.sh | sh
fly auth login

cd Minus-chrome-extension        # repo root (Dockerfile copies server/*)
fly launch --no-deploy --copy-config --dockerfile server/Dockerfile
#  -> pick an app name (e.g. minus-ingest) and region; it reads server/fly.toml

# persistent staging volume (HF is source-of-truth; this just resumes batches)
fly volumes create minus_data --region <your-region> --size 1

# secrets (NOT committed) — this is the only place the token lives
fly secrets set \
  HF_DATASET=GarageCyril/minus-web-captures \
  HF_TOKEN=hf_your_write_token \
  INGEST_KEY=your_openssl_rand_hex

fly deploy
```

## Verify
```bash
curl https://<your-app>.fly.dev/health
# {"ok":true,"queued":0,"uploaded":0,"pending":0,"dataset":"GarageCyril/minus-web-captures","upload":true}
```
`upload:true` means the HF token + dataset are wired. Send a test sample:
```bash
curl -X POST https://<your-app>.fly.dev/ingest \
  -H "content-type: application/json" -H "x-minus-key: your_key" \
  -d '{"v":1,"samples":[{"key":"test1","img":"data:image/png;base64,iVBORw0KGgo=","p_ad":0.9,"verdict":"ad","host":"example.com","w":300,"h":250,"engine":"lfm-iter14"}]}'
```
It should 200, and after `BATCH_UPLOAD` samples the files appear in the HF dataset.

## Point the extension at it
The extension keeps `ingestUrl` + `ingestKey` in settings (empty by default, so
collection is inert until set). Set them once — either bake defaults into the
build, or expose them in the popup/options. Values:
- `ingestUrl` = `https://<your-app>.fly.dev/ingest`
- `ingestKey` = the same `INGEST_KEY`

Only users who opt in (right-click → "Contribute anonymous ad snapshots") ever send anything.

## Local test (no Fly)
```bash
cp server/.env.example server/.env   # fill HF_DATASET/HF_TOKEN/INGEST_KEY
cd server && npm install
node --env-file=.env ingest-server.mjs
# leave HF_DATASET/HF_TOKEN empty to stage locally without uploading
```

## Security notes
- Fine-grained token scoped to one dataset = least privilege; rotate anytime in HF settings + `fly secrets set`.
- `INGEST_KEY` blocks anonymous POSTs; rate-limited to 120 req/min/IP; 40 MB body cap.
- Payload is element-crop + hostname only (no URLs/identifiers) — see PRIVACY.md.
