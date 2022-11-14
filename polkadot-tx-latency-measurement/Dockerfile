FROM node:16

WORKDIR /usr/src/polkadot

COPY . .

RUN npm install

CMD [ "node", "sendtx_polkadot.js" ]
