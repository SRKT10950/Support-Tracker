FROM node:22-alpine
ARG PORT=9010
ENV NODE_ENV=production PORT=${PORT}
WORKDIR /app
COPY index.html dashboard.html support.html my-tracker.html admin_app.js server.js ./
COPY assets ./assets
EXPOSE ${PORT}
USER node
CMD ["node", "server.js"]
