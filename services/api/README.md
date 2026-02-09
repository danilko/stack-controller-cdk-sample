# A Sample golang server to test the stack
## Test locally
```bash
# build the doc
# We add GOBIN to the path so we can run 'swag' immediately 
export PATH=$PATH:$(go env GOPATH)/bin
go install github.com/swaggo/swag/cmd/swag@latest

# generate docs
swag init

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