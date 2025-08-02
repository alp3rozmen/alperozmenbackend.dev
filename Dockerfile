# Node.js + Express Blog Backend Dockerfile
FROM node:20-alpine

# Çalışma dizini oluştur
WORKDIR /app

# Bağımlılıkları kopyala ve yükle
COPY package*.json ./
RUN npm install --production

# Uygulama dosyalarını kopyala
COPY . .

# Varsayılan port
EXPOSE 5000

# Uygulamayı başlat
CMD ["npm", "run", "start"]
