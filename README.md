# A Sample to demo ability to mananage share service and multi tenant stacks through one set of CDK

# STILL NOT STABLE, DO NOT USE IN PRODUCTION AS IS

Utilize layers of config
```
config
 |_common.yaml -> common values
 |_share-service.yaml -> share service stack config, inheirt any common if not override
 |_test-tenant-1123.yaml -> example tenant stack config, inheirt any common if not override

```

```yaml
# first deploy share service (please ensure to update all config in common folder)
cdk deploy -c tenantId=share-service

# deploy one of tenant 
cdk deploy -c tenantId=test-tenant-1123.yaml
```

