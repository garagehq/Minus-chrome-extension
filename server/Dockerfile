# Minus ingest server — small Node image, no Python (HF upload via @huggingface/hub).
FROM node:22-slim

WORKDIR /app

# only the server's deps
COPY server/package.json ./package.json
RUN npm install --omit=dev

COPY server/ingest-server.mjs ./ingest-server.mjs

ENV MINUS_INGEST_DIR=/data/captures
ENV PORT=8790
EXPOSE 8790

# HF_DATASET / HF_TOKEN / INGEST_KEY supplied at runtime (fly secrets / -e)
CMD ["node", "ingest-server.mjs"]
