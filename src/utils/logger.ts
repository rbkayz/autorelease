import { LoggingWinston } from '@google-cloud/logging-winston';
import winston from 'winston';

const { combine, prettyPrint, errors } = winston.format;

const maxLogSize = 256 * 1024; // 256KB

// Custom log trimmer formatter
const logTrimmer = winston.format((info) => {
  const logMessage = JSON.stringify(info);
  const logSize = Buffer.byteLength(logMessage, 'utf8');

  if (logSize > maxLogSize) {
    info.message = `${(info.message as any).slice(0, maxLogSize - 100)}... [TRIMMED]`;
    info.warning = 'Log message was trimmed due to size limit.';
  }

  return info;
});

export const logger = winston.createLogger({
  level: 'debug',
  format: combine(
    logTrimmer(),
    errors({ stack: true }),
    prettyPrint({
      colorize: true,
    })
  ),
  transports: [],
});

if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== 'local' && false) {
  const gcp_winston = new LoggingWinston({
    projectId: 'periskope',
    labels: {
      environment: process.env.NODE_ENV || 'local',
    },
    serviceContext: { service: 'autorelease' },
  });

  logger.add(gcp_winston);
} else {
  logger.add(new winston.transports.Console());
}

logger.on('error', (err) => {
  console.error(`Error in logger: ${err.message}`);
});
