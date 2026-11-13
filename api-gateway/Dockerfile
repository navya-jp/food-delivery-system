FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
ENV NODE_ENV=production
ENV PORT_GATEWAY=8080
ENV STANDALONE_GATEWAY=true
CMD ["node", "api-gateway/src/index.js"]
