FROM node:16

WORKDIR /usr/src/eos

COPY . .

RUN npm install

CMD [ "node", "sendtx_eos.js" ]