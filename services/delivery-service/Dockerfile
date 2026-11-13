FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4006
ENV NODE_ENV=production
ENV PORT_DELIVERY=4006
ENV STANDALONE_SERVICE=true
CMD ["node", "services/delivery-service/src/index.js"]
