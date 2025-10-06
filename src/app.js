const express = require('express');
const dotenv = require('dotenv');
const winston = require('winston');
const axios = require('axios');
const mediaQueue = require('./queue/mediaQueue');

// Load environment variables
dotenv.config();

// Initialize logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Function to notify primary server (used by queue processors)
async function notifyPrimaryServer(callbackUrl, data) {
  try {
      const response = await axios.post(callbackUrl, data, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'MediaQueue/1.0'
          }
      });
      logger.info(`Successfully notified primary server`, {
          callbackUrl,
          status: response.status,
          mediaId: data.mediaId
      });

      return response.data;
  } catch (error) {
      logger.error(`Failed to notify primary server`, {
          callbackUrl,
          error: error.message,
          mediaId: data.mediaId
      });
      throw error;
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const queueHealth = await mediaQueue.getWaiting().then(() => true).catch(() => false);
    logger.info('Received helth request', queueHealth);
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        queue: queueHealth ? 'healthy' : 'unhealthy',
        ffmpeg: 'available'
      },
      queue: {
        waiting: (await mediaQueue.getWaiting()).length,
        active: (await mediaQueue.getActive()).length,
        completed: (await mediaQueue.getCompleted()).length,
        failed: (await mediaQueue.getFailed()).length
      }
    };
    
    res.json(health);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Queue metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      mediaQueue.getWaiting(),
      mediaQueue.getActive(),
      mediaQueue.getCompleted(),
      mediaQueue.getFailed()
    ]);

    res.json({
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Metrics failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export the callback function for use in queue processors
module.exports = { notifyPrimaryServer };

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}, shutting down gracefully`);
  
  try {
    await mediaQueue.close();
    logger.info('Queue connections closed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception thrown:', error);
  process.exit(1);
});
// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Media queue monitoring server running on port ${PORT}`);
});

module.exports = { notifyPrimaryServer };