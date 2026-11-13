FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4004
ENV NODE_ENV=production
ENV PORT_KITCHEN=4004
ENV STANDALONE_SERVICE=true
CMD ["node", "services/kitchen-service/src/index.js"]
