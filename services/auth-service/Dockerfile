FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 4001
ENV NODE_ENV=production
ENV PORT_AUTH=4001
ENV STANDALONE_SERVICE=true
CMD ["node", "services/auth-service/src/index.js"]
