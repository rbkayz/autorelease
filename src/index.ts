import axios from 'axios';
import { config } from 'dotenv';
import { Probot, Server } from 'probot';
import { probotHandler } from './events';
import { logger } from './utils/logger';

config();

async function startServer() {
  // Server
  const server = new Server({
    Probot: Probot.defaults({
      appId: process.env.APP_ID,
      privateKey: process.env.PRIVATE_KEY?.replace(/\\n/g, '\n'),
      secret: process.env.WEBHOOK_SECRET,
    }),
    port: parseInt(process.env.PORT || '8888'),
    webhookProxy: process.env.WEBHOOK_PROXY_URL,
  });

  // Health check route
  server.router().get('/health', (req, res) => {
    res.send({ message: 'Service is online' });
  });

  await server.load(probotHandler);

  server.start().then(() => {
    logger.info('Server is running on port 8888');
  });
}

startServer();

setInterval(() => {
  axios.get('http://localhost:8888/health').then((res) => {
    logger.info(res.data);
  });
}, 60000);
