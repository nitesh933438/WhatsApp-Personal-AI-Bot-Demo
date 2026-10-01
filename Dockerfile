FROM node:20

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
