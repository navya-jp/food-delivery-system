FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4002
ENV NODE_ENV=production
ENV PORT_RESTAURANT=4002
ENV STANDALONE_SERVICE=true
CMD ["node", "services/restaurant-service/src/index.js"]
