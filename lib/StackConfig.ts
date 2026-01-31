
export class AwsConfig {
  region: string
  accountId: string
}

export class DockerImage {
  tag: string
}

export class ApiServiceConfig {
  image: DockerImage
}

export class BatchServiceConfig {
  image: DockerImage
}


export class TenantStackConfig {
  tenantId: string
  aws: AwsConfig
  apiService: ApiServiceConfig
  batchService:BatchServiceConfig
}