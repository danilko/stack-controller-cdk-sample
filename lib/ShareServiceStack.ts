import * as cdk from 'aws-cdk-lib';
import {CfnOutput, RemovalPolicy, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
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

    // Allow the entire account to use this key,
    // provided the IAM principal also has permissions.
    shareServiceKmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Enable IAM User Permissions',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()], // Trust the account's IAM policies
      actions: ['kms:*'],
      resources: ['*'],
    }));

    // Specific ECR Service permission (Good for 2026 security standards)
    shareServiceKmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Allow ECR to use the key for decryption',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('ecr.amazonaws.com')],
      actions: [
        'kms:Decrypt',
        'kms:DescribeKey',
        'kms:CreateGrant',
        'kms:RetireGrant'
      ],
      resources: ['*'],
    }));

    const apiServiceECR = new ecr.Repository(this, `${tenantId}-api-service`, {
      repositoryName: `${tenantId}-api-service`,
      encryptionKey: shareServiceKmsKey,
      imageTagMutability: ecr.TagMutability.MUTABLE, // allow to push to same tag
      imageScanOnPush: true, // Optional: enables image scanning on push
      encryption: ecr.RepositoryEncryption.KMS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new CfnOutput(this, "share-service-kmsKeyArn", { value: shareServiceKmsKey.keyArn, exportName: "share-service-kmsKeyArn"});
    new CfnOutput(this, "share-service-apiServiceECRArn", { value: apiServiceECR.repositoryArn , exportName: "share-service-apiServiceECRArn"});
    // Export the Name (Required to satisfy the late-binding error)
    new cdk.CfnOutput(this, 'share-service-apiECRName', {value: apiServiceECR.repositoryName, exportName: 'share-service-apiServiceECRName',});

    new CfnOutput(this, "share-service-apiServiceECRUri", { value: apiServiceECR.repositoryUri , exportName: "share-service-apiServiceECRUri"});

  }
}