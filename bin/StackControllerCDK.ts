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
const loadConfig = (tenantId: string):TenantStackConfig => {
  const lowerTenantId = tenantId.toLowerCase();
  const configPath = path.join(__dirname, '../config', `${lowerTenantId}.yaml`);

  if (!fs.existsSync(configPath)) {
    console.error(`Error: Config file for tenant ${lowerTenantId} not found at ${configPath}`);
    process.exit(1);
  }

  try {
    const fileContents = fs.readFileSync(configPath, 'utf8');
    return yaml.load(fileContents) as TenantStackConfig;
  } catch (e) {
    console.error(`Error parsing YAML: ${e}`);
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
}
else{
  new TenantStack(app, `${tenantId}-tenant-stack`, tenantConfig, {
    env: targetEnv
  });
}
app.synth();