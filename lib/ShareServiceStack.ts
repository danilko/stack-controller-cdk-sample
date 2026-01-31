import * as cdk from 'aws-cdk-lib';
import {CfnOutput, RemovalPolicy, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ecr from 'aws-cdk-lib/aws-ecr'
import {TenantStackConfig} from "./StackConfig";

const tenantId = 'share-service';

export class ShareServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, tenantStackConfig: TenantStackConfig, props: StackProps) {
    super(scope, id, props);

    // Encryption - Custom KMS Key
    const shareServiceKmsKey = new kms.Key(this, `${tenantId}-key`, {
      alias: `alias/${tenantId}-key`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep the key even if stack is deleted
    });

    const batchServiceECR = new ecr.Repository(this, `${tenantId}-batch-service`, {
      repositoryName: `${tenantId}-batch-service`,
      encryptionKey: shareServiceKmsKey,
      imageScanOnPush: true, // Optional: enables image scanning on push
      encryption: ecr.RepositoryEncryption.KMS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const apiServiceECR = new ecr.Repository(this, `${tenantId}-api-service`, {
      repositoryName: `${tenantId}-api-service`,
      encryptionKey: shareServiceKmsKey,
      imageScanOnPush: true, // Optional: enables image scanning on push
      encryption: ecr.RepositoryEncryption.KMS,
      removalPolicy: RemovalPolicy.DESTROY,
    });


    new CfnOutput(this, "share-service-batchServiceECRArn", { value: batchServiceECR.repositoryArn , exportName: "share-service-batchServiceECRArn"});
    new CfnOutput(this, "share-service-apiServiceECRArn", { value: apiServiceECR.repositoryArn , exportName: "share-service-apiServiceECRArn"});
  }
}