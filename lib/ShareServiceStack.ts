import * as cdk from 'aws-cdk-lib';
import {CfnOutput, RemovalPolicy, StackProps, Tags} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as iam from 'aws-cdk-lib/aws-iam'
import {TenantStackConfig} from "./StackConfig";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as guardduty from "aws-cdk-lib/aws-guardduty";


export class ShareServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, tenantStackConfig: TenantStackConfig, props: StackProps) {
    super(scope, id, props);

    const tenantId = tenantStackConfig.tenantId;
    const environment = tenantStackConfig.environment;

    // Apply to everything in the stack
    Tags.of(this).add('tenantId', tenantId);
    Tags.of(this).add('environment', tenantStackConfig.environment);
    Tags.of(this).add('region', this.region);
    // Encryption - Custom KMS Key
    const shareServiceKmsKey = new kms.Key(this, `${tenantId}-${environment}-${this.region}-key`, {
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

    // Storage - Ingest Data Bucket
    const shareServiceIngestBucket = new s3.Bucket(this, `${tenantId}-${environment}-ingest`, {
      bucketName: `${tenantId}-${environment}-${this.region}-ingest`,
      encryptionKey: shareServiceKmsKey,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      publicReadAccess: false,
      enforceSSL: true,
      bucketKeyEnabled: true, // Reduces KMS costs and required for GuardDuty access
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true, // perform for easily debug only, should not use for production
    });

    // Create an IAM Role for GuardDuty Malware Protection
    // This allows GuardDuty to scan objects and decrypt them using your KMS key
    const guarddutyIAMRole = new iam.Role(this, 'GuardDutyMalwareScanRole', {
      assumedBy: new iam.ServicePrincipal('malware-protection-plan.guardduty.amazonaws.com'),
    });

    // Grant GuardDuty permissions to read/tag objects and use the KMS key
    shareServiceIngestBucket.grantRead(guarddutyIAMRole);

    // Allow get/tag
    // The kms key is on next, so not directly use s3 grant access method
    guarddutyIAMRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObjectTagging', 's3:GetObjectTagging'],
      resources: [shareServiceIngestBucket.bucketArn],
    }));

    // For access to different services encrypt with kms
    guarddutyIAMRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:CreateGrant', 'kms:RetireGrant', 'kms:GenerateDataKey'], // Decrypt is needed for reading, GenerateDataKey for uploading
      resources: [shareServiceKmsKey.keyArn],
    }));


    // 4. Enable GuardDuty Malware Protection for the bucket
    // This triggers a scan every time a new object is created
    new guardduty.CfnMalwareProtectionPlan(this, 'S3MalwareProtection', {
      protectedResource: {
        s3Bucket: {
          bucketName: shareServiceIngestBucket.bucketName,
        },
      },
      role: guarddutyIAMRole.roleArn,
      actions: {
        tagging: {
          status: 'ENABLED', // Tags objects with 'GuardDutyMalwareScanStatus'
        },
      },
    });

    new CfnOutput(this, `${tenantId}-${environment}-${this.region}-kmsKeyArn`, { value: shareServiceKmsKey.keyArn, exportName: `${tenantId}-${environment}-${this.region}-kmsKeyArn`});
    new CfnOutput(this,  `${tenantId}-${environment}-${this.region}-apiSvcECRArn`, { value: apiServiceECR.repositoryArn , exportName: `${tenantId}-${environment}-${this.region}-apiSvcECRArn`});
    // Export the Name (Required to satisfy the late-binding error)
    new cdk.CfnOutput(this, `${tenantId}-${environment}-${this.region}-apiSvcECRName`, {value: apiServiceECR.repositoryName, exportName: `${tenantId}-${environment}-${this.region}-apiSvcECRName`});

    new CfnOutput(this, `${tenantId}-${environment}-${this.region}-apiSvcECRUri`, { value: apiServiceECR.repositoryUri , exportName: `${tenantId}-${environment}-${this.region}-apiSvcECRUri`});
    new CfnOutput(this, `${tenantId}-${environment}-${this.region}-ingestBucketArn`, { value: shareServiceIngestBucket.bucketArn , exportName: `${tenantId}-${environment}-${this.region}-ingestBucketArn`});
  }
}