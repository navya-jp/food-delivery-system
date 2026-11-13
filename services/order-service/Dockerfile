FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4003
ENV NODE_ENV=production
ENV PORT_ORDER=4003
ENV STANDALONE_SERVICE=true
CMD ["node", "services/order-service/src/index.js"]
