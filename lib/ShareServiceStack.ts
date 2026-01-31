import * as cdk from 'aws-cdk-lib';
import {RemovalPolicy, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ecr from 'aws-cdk-lib/aws-ecr'
import {TenantStackConfig} from "./StackConfig";


export class ShareServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, tenantStackConfig: TenantStackConfig, props: StackProps) {
    super(scope, id, props);

    const tenantId = 'share-service';

    // Encryption - Custom KMS Key
    const shareServiceKmsKey = new kms.Key(this, `${tenantId}-key`, {
      alias: `alias/${tenantId}-key`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep the key even if stack is deleted
    });


    const repository = new ecr.Repository(this, `${tenantId}-docker-release-repository`, {
      repositoryName: `${tenantId}-docker-release-repository`,
      encryptionKey: shareServiceKmsKey,
      encryption: ecr.RepositoryEncryption.KMS,
      removalPolicy: RemovalPolicy.DESTROY
    });
  }
}