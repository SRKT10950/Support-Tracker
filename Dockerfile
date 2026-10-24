FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY index.html admin_app.js server.js ./
EXPOSE 8080
USER node
CMD ["node", "server.js"]
