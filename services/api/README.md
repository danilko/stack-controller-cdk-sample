# A Sample golang server to test the stack
## Test locally
```bash
# build the doc
# We add GOBIN to the path so we can run 'swag' immediately 
export PATH=$PATH:$(go env GOPATH)/bin

# Build the static binary
CGO_ENABLED=0 GOOS=linux go build -o main .



```
## Docker image build

```bash
# build and push the docker images
cd services/api/
docker build -t api-al2023 .

# optional test docker image
docker run -p 8080:8080 api-al2023 
# should able to hit http://localhost:8080/api/v1/health and get result
# exit the above docker run by doing ctrl + C
```

## TEST LOCALLY (WORK IN PROGRESS)
```bash

# assume the tenant cluster is setup and aws environment variables are setup

# please check full variables on TenatStack.ts's ECS environment variables for now

# setup database, swap credential with desired target
export SQS_TENANT_INGEST_S3_QUEUE_URL=""

export DB_HOST=localhost
export DB_PORT=5432
export DB_USER=postgres
export DB_PASSWORD=<credential>
export DB_NAME=postgres
export BEDROCK_MODEL_ID="anthropic.claude-3-sonnet-20240229-v1:0"

export S3_SHARE_SERVICE_INGEST_BUCKET_NAME="share-service-ingest-bucket"
export S3_TENANT_DATA_BUCKET_NAME="test-tenant-1123-data-bucket"
export KMS_TENANT_KEY_ARN="<key arn>"
export TENANT_ID="test-tenant-1123"

docker run --name local-db -e POSTGRES_PASSWORD=${DB_PASSWORD} -p 5432:5432 -d postgres

go run main.go

```