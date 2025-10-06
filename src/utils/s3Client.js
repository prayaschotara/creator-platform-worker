const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const axios = require('axios');;
const winston = require('winston');
const dotenv = require('dotenv');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Load environment variables
dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class S3Service {
  constructor() {
    this.domain = 'https://creator-platform-bucket.ams3.digitaloceanspaces.com'
    this.bucket = process.env.DO_SPACES_BUCKET;
    this.client = new S3Client({
      endpoint: process.env.DO_SPACES_ENDPOINT,
      region: process.env.DO_SPACES_REGION,
      accessKeyId: process.env.DO_SPACES_KEY,
      secretAccessKey: process.env.DO_SPACES_SECRET,
      signatureVersion: 'v4'
    });
  }

  async getSignedUrlForRead(key, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
      const signedUrl = await getSignedUrl(this.client, command, { expiresIn });
      logger.debug(`Generated signed URL for read: ${key}`);
      return signedUrl;
    } catch (error) {
      logger.error(`Failed to generate signed URL for ${key}: ${error.message}`);
      throw error;
    }
  }

  async getSignedUrlForWrite(key, expiresIn = 3600) {
    try {
      const command = new PutObjectCommand({ Bucket: this.bucket, Key: key });
      const signedUrl = await getSignedUrl(this.client, command, { expiresIn });
      logger.debug(`Generated signed URL for write: ${key}`);
      return signedUrl;
    } catch (error) {
      logger.error(`Failed to generate signed URL for write ${key}: ${error.message}`);
      throw error;
    }
  }

  async downloadFromUrl(url, localPath) {
    try {
      logger.info(`Downloading file from URL: ${url} to ${localPath}`);

      const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
        timeout: 60000, // 60 seconds timeout
        headers: {
          'User-Agent': 'MediaProcessor/1.0'
        }
      });

      // Ensure directory exists
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const writer = fs.createWriteStream(localPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          logger.info(`File downloaded successfully to: ${localPath}`);
          resolve(localPath);
        });
        writer.on('error', (error) => {
          logger.error(`Failed to write file: ${error.message}`);
          reject(error);
        });
        response.data.on('error', (error) => {
          logger.error(`Failed to download from URL: ${error.message}`);
          reject(error);
        });
      });
    } catch (error) {
      logger.error(`Download failed: ${error.message}`, { url, localPath });
      throw error;
    }
  }

  async uploadFile(localPath, s3Key) {
    try {
      logger.info(`Uploading file to S3: ${s3Key}`, {
        bucket: this.bucket
      });

      const fileStream = fs.createReadStream(localPath);

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: fileStream,
      });
      
      await this.client.send(command);

      const publicUrl = `${this.domain}/${s3Key}`;
      logger.info(`File uploaded successfully: ${publicUrl}`);

      return publicUrl;
    } catch (error) {
      logger.error(`Failed to upload file: ${error.message}`, {
        localPath,
        s3Key,
        bucket: this.bucket
      });
      throw error;
    }
  }

  async uploadBuffer(buffer, s3Key, contentType) {
    try {
      logger.debug(`Uploading buffer to S3: ${s3Key}`, {
        bucket: this.bucket,
        size: buffer.length,
        contentType
      });

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read',
      });

      await this.client.send(command);

      const publicUrl = `${this.domain}/${this.bucket}/${s3Key}`;
      logger.debug(`Buffer uploaded successfully: ${publicUrl}`);

      return publicUrl;
    } catch (error) {
      logger.error(`Failed to upload buffer: ${error.message}`, {
        s3Key,
        bucket: this.bucket,
        bufferSize: buffer.length
      });
      throw error;
    }
  }

  async deleteFile(s3Key) {
    try {
      logger.info(`Deleting file from S3: ${s3Key}`, {
        bucket: this.bucket
      });

      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
      });

      await this.client.send(command);

      logger.info(`File deleted successfully: ${s3Key}`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete file: ${error.message}`, {
        s3Key,
        bucket: this.bucket
      });
      throw error;
    }
  }

  async deleteFiles(s3Keys) {
    try {
      logger.info(`Deleting ${s3Keys.length} files from S3`, {
        bucket: this.bucket
      });

      const results = await Promise.allSettled(
        s3Keys.map(key => this.deleteFile(key))
      );

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      logger.info(`Deleted ${successful} files successfully, ${failed} failures`);

      return {
        successful,
        failed,
        results
      };
    } catch (error) {
      logger.error(`Failed to delete multiple files: ${error.message}`);
      throw error;
    }
  }

  // Check if file exists at direct URL
  async fileExistsAtUrl(url) {
    try {
      const response = await axios.head(url, {
        timeout: 5000,
        headers: {
          'User-Agent': 'MediaProcessor/1.0'
        }
      });
      return response.status === 200;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return false;
      }
      throw error;
    }
  }

  // Helper method to check if file exists
  async fileExists(s3Key) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

//   async downloadFile(s3Key, localPath) {
//     const command = new GetObjectCommand({
//         Bucket: 'your-bucket-name',
//         Key: s3Key,
//     });
    
//     const response = await s3.send(command);
//     const fileStream = fs.createWriteStream(localPath);
    
//     await new Promise((resolve, reject) => {
//         response.Body.pipe(fileStream)
//             .on('finish', resolve)
//             .on('error', reject);
//     });
// }
}

module.exports = new S3Service();