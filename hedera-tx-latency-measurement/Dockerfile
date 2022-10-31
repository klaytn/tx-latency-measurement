FROM node:16

WORKDIR /usr/src/hedera

COPY . .

RUN npm install

CMD [ "node", "sendtx_hedera.js" ]