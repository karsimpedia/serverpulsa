# Ganti alpine -> debian (lebih kompatibel utk Prisma)
FROM node:20-bullseye AS base
WORKDIR /app

# SSL & CA (umumnya sudah ada di debian, tapi amankan)
RUN apt-get update -y && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npx prisma generate

EXPOSE 3000
