FROM node:16

WORKDIR /usr/src/near

COPY . .

RUN npm install

CMD [ "node", "sendtx_near.js" ]