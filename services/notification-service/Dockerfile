FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4007
ENV NODE_ENV=production
ENV PORT_NOTIFICATION=4007
ENV STANDALONE_SERVICE=true
CMD ["node", "services/notification-service/src/index.js"]
