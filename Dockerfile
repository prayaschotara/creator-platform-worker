# Use Ubuntu as base image for better FFmpeg support
FROM ubuntu:22.04

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    ca-certificates \
    software-properties-common \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 18
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Install FFmpeg with additional codecs
RUN add-apt-repository ppa:savoury1/ffmpeg4 \
    && apt-get update \
    && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Sharp dependencies
RUN apt-get update && apt-get install -y \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installation
RUN ffmpeg -version && ffprobe -version

# Create app directory
WORKDIR /usr/src/app

# Create logs directory
RUN mkdir -p logs

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create temp directory for processing
RUN mkdir -p /tmp/processing && chmod 777 /tmp/processing

# Create non-root user
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && chown -R appuser:appuser /usr/src/app \
    && chown -R appuser:appuser /tmp/processing

# Switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3001}/health || exit 1

# Expose port
EXPOSE 3001

# Start the application
CMD ["npm", "start"]