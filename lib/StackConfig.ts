
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

export class Services {
  api: ApiServiceConfig
}


export class TenantStackConfig {
  tenantId: string
  aws: AwsConfig
  services: Services
}