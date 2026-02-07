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
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apiServiceECR = new ecr.Repository(this, `${tenantId}-api-service`, {
      repositoryName: `${tenantId}-api-service`,
      encryptionKey: shareServiceKmsKey,
      imageTagMutability: ecr.TagMutability.MUTABLE, // allow to push to same tag
      imageScanOnPush: true, // Optional: enables image scanning on push
      encryption: ecr.RepositoryEncryption.KMS,
      removalPolicy: RemovalPolicy.DESTROY,
    });


    new CfnOutput(this, "share-service-apiServiceECRArn", { value: apiServiceECR.repositoryArn , exportName: "share-service-apiServiceECRArn"});
    // Export the Name (Required to satisfy the late-binding error)
    new cdk.CfnOutput(this, 'share-service-apiECRName', {value: apiServiceECR.repositoryName, exportName: 'share-service-apiServiceECRName',});

    new CfnOutput(this, "share-service-apiServiceECRUri", { value: apiServiceECR.repositoryUri , exportName: "share-service-apiServiceECRUri"});

  }
}