FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY stay-put.js .

ENV NODE_ENV=production

CMD ["node", "stay-put.js"]
