
export class AwsConfig {
  region: string
  accountId: string
}

export class ApiServiceConfig {
  image: string
}

export class BatchServiceConfig {
  image: string
}


export class TenantStackConfig {
  tenantId: string
  aws: AwsConfig
  apiService: ApiServiceConfig
  batchService:BatchServiceConfig
}