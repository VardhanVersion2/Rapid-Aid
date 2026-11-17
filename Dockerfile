FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    UPLOADS_DIR=/app/uploads

WORKDIR /app
COPY server.js package.json ./
COPY public ./public

RUN mkdir -p /app/data /app/uploads/audio /app/uploads/photos \
    && chown -R node:node /app

USER node
EXPOSE 3000
VOLUME ["/app/data", "/app/uploads"]
CMD ["node", "server.js"]
