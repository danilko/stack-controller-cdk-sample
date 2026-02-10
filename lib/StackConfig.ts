export const SHARE_SERVICE_TENANT_ID = 'share-service'

export class AwsConfig {
  region: string
  accountId: string
}

export class DockerImage {
  tag: string
}

export class ApiServiceConfig {
  image: DockerImage
  bedrockModelId: string
}

export class Services {
  api: ApiServiceConfig
}


export class TenantStackConfig {
  tenantId: string
  environment: string
  aws: AwsConfig
  services: Services
}