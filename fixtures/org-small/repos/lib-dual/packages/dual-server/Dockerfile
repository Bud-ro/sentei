FROM node:20-slim
WORKDIR /srv
COPY . .
RUN npm run build
HEALTHCHECK --interval=5s CMD node -e "fetch('http://localhost:8080/health')"
CMD ["node", "/srv/dist/worker.js"]
