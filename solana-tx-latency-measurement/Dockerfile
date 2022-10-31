FROM node:16

WORKDIR /usr/src/solana

COPY . .

RUN npm install

CMD [ "node", "sendtx_solana.js" ]