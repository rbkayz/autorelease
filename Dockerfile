FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install ALL dependencies (including devDependencies needed for build)
RUN yarn install --frozen-lockfile

# Copy the rest of the application
COPY . .

# Build the TypeScript code
RUN yarn build

# Start the application
CMD [ "yarn", "start" ]
