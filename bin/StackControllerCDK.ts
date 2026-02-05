import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {TenantStack} from "../lib/TenantStack";
import {TenantStackConfig} from "../lib/StackConfig";
import {ShareServiceStack} from "../lib/ShareServiceStack";

const app = new cdk.App();

// Get tenant_id from context (e.g., cdk deploy -c tenantId=cust-001)
const tenantId = app.node.tryGetContext('tenantId');

if (!tenantId) {
  console.error('No target cluster id provided. Use -c tenant_id=<id> to target a specific stack.');
  process.exit(1);
}

// Load Configuration
const loadConfig = (tenantId: string): TenantStackConfig => {
  const lowerTenantId = tenantId.toLowerCase();

  const commonConfigPath = path.join(__dirname, '../config', `common.yaml`);

  const tenantConfigPath = path.join(__dirname, '../config', `${lowerTenantId}.yaml`);

  let finalConfig = {} as any;

  try {
    // Load Common Config (The Baseline)
    if (fs.existsSync(commonConfigPath)) {
      const commonContent = fs.readFileSync(commonConfigPath, 'utf8');
      finalConfig = yaml.load(commonContent) || {};

    } else {
      console.warn(`Warning: common.yaml not found at ${commonConfigPath}`);
    }

    // Load tenant setting for override
    if (fs.existsSync(tenantConfigPath)) {
      const tenantContent = fs.readFileSync(tenantConfigPath, 'utf8');
      const tenantConfig = yaml.load(tenantContent) as Record<string, any>;

      // Merge: Tenant fields will overwrite common fields
      finalConfig = {...finalConfig, ...tenantConfig};
    } else {
      console.error(`Error: Config file for tenant ${lowerTenantId} not found at ${tenantConfigPath}`);
      process.exit(1);
    }

    return finalConfig as TenantStackConfig;

  } catch (e) {
    console.error(`Error parsing tenant config YAML: ${e}`);
    process.exit(1);
  }
};

const tenantConfig = loadConfig(tenantId);

const targetEnv: cdk.Environment = {
  account: (tenantConfig.aws.accountId).toString(),
  region: tenantConfig.aws.region,
};

// If not share service, assign to tenant stack
if (tenantId === 'share-service') {
  new ShareServiceStack(app, `share-service-stack`, tenantConfig, {
    env: targetEnv
  });
} else {
  new TenantStack(app, `${tenantId}-tenant-stack`, tenantConfig, {
    env: targetEnv
  });
}
app.synth();