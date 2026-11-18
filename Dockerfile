# Déploiement en ligne (serveur + LibreOffice pour convertir les PowerPoint)
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-impress fonts-dejavu fonts-liberation fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV PORT=4517 DATA_DIR=/data
VOLUME /data
EXPOSE 4517
CMD ["node", "server/start.js"]
