FROM node:16

WORKDIR /usr/src/avalanche

COPY . .

RUN npm install

CMD [ "node", "sendtx_avalanche.js" ]