# A Sample to demo ability to manage share service and multi tenant stacks through one set of CDK

# STILL NOT STABLE, DO NOT USE IN PRODUCTION AS IS

## Overall Architecture

Overall Setup Flow
![multi-tenants-stack-setup.drawio.png](diagrams/multi-tenants-stack-setup.drawio.png)

- Ability to use one cdk repo to deploy/manage one share service stack and multi-tenant specific services stack with either same consistency or tenant override

Malware scan upload flow
![upload-flow.drawio.png](diagrams/upload-flow.drawio.png)

- Above utilize an ingest bucket to overcome the current hard limit of 25 buckets for guard duty.
- STS token will be generated on user upload with tenant specific kms key, and other key will not be allowed to further strength ingest
- EventBridge to SQS based on S3 key to target tenant SQS
- Backend pull SQS to move valid data to tenant data s3 bucket and remove ones that are not valid

Utilize layers of config
```text
config
  |_dev -> environment
    |_common.yaml -> common values
    |_share-service.yaml -> share service stack config, inherit any common if not override
    |_test-tenant-1123.yaml -> example tenant stack config, inherit any common if not override
```

## Requirements
1. Install [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting-started.html)

## Setup Steps

1. Setup share service and deploy docker images into ecr
```bash
# first deploy share service (please ensure to update all config in common folder)
cdk deploy -c tenantId=share-service

# login to ECR registry
#  uri from above share service output, such as 111116177016.dkr.ecr.us-west-2.amazonaws.com/share-service-api-service
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin 111116177016.dkr.ecr.us-west-2.amazonaws.com/share-service-dev-api-service

# build and push the docker images
cd services/api/
docker build -t api-al2023 .

# optional test docker image
docker run -p 8080:8080 api-al2023 
# should able to hit http://localhost:8080/api/v1/health and get result
# exit the above docker run by doing ctrl + C

docker tag api-al2023:latest 111116177016.dkr.ecr.us-west-2.amazonaws.com/share-service-dev-api-service:1.0
docker push 111116177016.dkr.ecr.us-west-2.amazonaws.com/share-service-dev-api-service:1.0
# back to root
cd ../../
```

2. Deploy one of tenant 
```bash
cdk deploy -c tenantId=test-tenant-1123.yaml
```

