FROM --platform=linux/amd64 node:22.16.0-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV DATA_DIR=/app/data HOST=0.0.0.0 PORT=4318
EXPOSE 4318
CMD ["npm","start"]
