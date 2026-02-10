import * as cdk from 'aws-cdk-lib';
import {CfnOutput, RemovalPolicy, StackProps, Tags} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import {TenantStackConfig} from "./StackConfig";



export class ShareServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, tenantStackConfig: TenantStackConfig, props: StackProps) {
    super(scope, id, props);

    const tenantId = tenantStackConfig.tenantId;
    const environment = tenantStackConfig.environment;

    // Apply to everything in the stack
    Tags.of(this).add('tenantId', tenantId);
    Tags.of(this).add('environment', tenantStackConfig.environment);

    // Encryption - Custom KMS Key
    const shareServiceKmsKey = new kms.Key(this, `${tenantId}-${environment}-key`, {
      alias: `alias/${tenantId}-${environment}-key`,
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

    // Specific AWS Service permission
    shareServiceKmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Allow AWS services to use the key for decryption',
      effect: iam.Effect.ALLOW,
      principals: [
        new iam.ServicePrincipal('s3.amazonaws.com'),
        new iam.ServicePrincipal('ecr.amazonaws.com'),
        new iam.ServicePrincipal('ecs.amazonaws.com'),
        new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`), // CloudWatch Logs
        new iam.ServicePrincipal('sqs.amazonaws.com'),
        new iam.ServicePrincipal('events.amazonaws.com'), // EventBridge
        new iam.ServicePrincipal('rds.amazonaws.com'),
      ],
      actions: [
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*', // for s3
        'kms:DescribeKey'
      ],
      resources: ['*'],
    }));

    const apiServiceECR = new ecr.Repository(this, `${tenantId}-${environment}-apiSvc`, {
      repositoryName: `${tenantId}-${environment}-api-svc`,
      encryptionKey: shareServiceKmsKey,
      imageTagMutability: ecr.TagMutability.MUTABLE, // allow to push to same tag
      imageScanOnPush: true, // Optional: enables image scanning on push
      encryption: ecr.RepositoryEncryption.KMS,
      removalPolicy: RemovalPolicy.DESTROY,
      // Configure AWS to automatically clear out all images before attempting deletion
      emptyOnDelete: true,
    });

    new CfnOutput(this, `${tenantId}-${environment}-kmsKeyArn`, { value: shareServiceKmsKey.keyArn, exportName: `${tenantId}-${environment}-kmsKeyArn`});
    new CfnOutput(this,  `${tenantId}-${environment}-apiSvcECRArn`, { value: apiServiceECR.repositoryArn , exportName: `${tenantId}-${environment}-apiSvcECRArn`});
    // Export the Name (Required to satisfy the late-binding error)
    new cdk.CfnOutput(this, `${tenantId}-${environment}-apiSvcECRName`, {value: apiServiceECR.repositoryName, exportName: `${tenantId}-${environment}-apiSvcECRName`});

    new CfnOutput(this, `${tenantId}-${environment}-apiSvcECRUri`, { value: apiServiceECR.repositoryUri , exportName: `${tenantId}-${environment}-apiSvcECRUri`});

  }
}