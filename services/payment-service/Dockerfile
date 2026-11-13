FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4005
ENV NODE_ENV=production
ENV PORT_PAYMENT=4005
ENV STANDALONE_SERVICE=true
CMD ["node", "services/payment-service/src/index.js"]
