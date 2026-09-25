FROM node:22-alpine

WORKDIR /app

COPY server.mjs ./

EXPOSE 8788

ENV NODE_ENV=production
ENV PORT=8788
ENV HOST=0.0.0.0

CMD ["node", "server.mjs"]
