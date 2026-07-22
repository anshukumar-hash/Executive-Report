# ---- build stage: install deps against the committed lockfile ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# ---- runtime stage ----
FROM node:20-slim
WORKDIR /app
COPY --from=build /app ./
EXPOSE 8080
CMD ["node", "server.js"]
