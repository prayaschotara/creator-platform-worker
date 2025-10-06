/* eslint-disable esm/no-commonjs */
const path = require('path');
const fs = require("fs/promises");
const winston = require('winston');
const s3Client = require('../utils/s3Client');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class MediaUploaderService {
    async uploadDirectory(localDirectoryPath, destinationDirectoryPath) {
        const targetDestination = destinationDirectoryPath;
        const uploadedFiles = [];
    
        const files = await fs.readdir(localDirectoryPath);
    
        for (const file of files) {
            const fullPath = path.join(localDirectoryPath, file);
            const key = `${targetDestination}/${file}`; // S3 key
            console.log("fullpath::::::::::::", fullPath)
            await s3Client.uploadFile(fullPath, key);
            
            // Store the uploaded file info
            uploadedFiles.push({
                originalName: file,
                s3Key: key,
                url: `${process.env.DO_SPACES_ENDPOINT}/${key}`
            });
    
            logger.info(`Uploaded: ${key}`);
        }
    
        return uploadedFiles;
    }
}
module.exports = new MediaUploaderService();