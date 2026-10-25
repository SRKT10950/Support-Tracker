FROM node:22-alpine
ARG PORT=8080
ENV NODE_ENV=production PORT=${PORT}
WORKDIR /app
COPY index.html admin_app.js server.js ./
EXPOSE ${PORT}
USER node
CMD ["node", "server.js"]
