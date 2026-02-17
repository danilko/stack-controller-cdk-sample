# --- Stage 1: Build Stage (using Amazon Linux 2023) ---
FROM amazonlinux:2023 AS builder

# 1. Install Go and Git (required for downloading dependencies)
RUN dnf update -y && \
    dnf install -y golang git && \
    dnf clean all

# Set working directory
WORKDIR /app

# Copy go mod and sum files
COPY go.mod go.sum ./
RUN go mod tidy
RUN go mod download

# 2. Install Swag CLI inside this AL2023 environment
# We add GOBIN to the path so we can run 'swag' immediately
ENV PATH=$PATH:/root/go/bin
# Copy source and generate docs
COPY . .

# Build the static binary
RUN CGO_ENABLED=0 GOOS=linux go build -o main .

# --- Stage 2: Runtime Stage ---
FROM amazonlinux:2023

# Set working directory
WORKDIR /root/

# Copy the binary and the generated docs from the builder stage
COPY --from=builder /app/main .
COPY --from=builder /app/docs ./docs

# Expose the port the app runs on
EXPOSE 8080

# Command to run the executable
CMD ["./main"]