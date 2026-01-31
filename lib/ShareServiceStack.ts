import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import {aws_cloudfront_origins, CfnOutput, Duration, RemovalPolicy, StackProps} from "aws-cdk-lib";
import {TenantStackConfig} from "./StackConfig";
import {OriginAccessIdentity} from "aws-cdk-lib/aws-cloudfront";


export class ShareServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, tenantStackConfig: TenantStackConfig, props: StackProps) {
    super(scope, id, props);

    const tenantId = tenantStackConfig.tenantId;

    // Encryption - Custom KMS Key
    const tenantKmsKey = new kms.Key(this, `${tenantId}-key`, {
      alias: `alias/${tenantId}-service-key`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep the key even if stack is deleted
    });

    // Networking
    const vpc = new ec2.Vpc(this, `${tenantId}-vpc`, {
      maxAzs: 2,
    });

    // Security - WAF (Simplified HIPAA-like set)
    const waf = new wafv2.CfnWebACL(this, `${tenantId}-waf`, {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${tenantId}-waf-metric`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: 'AWSManagedRulesCommonRuleSet',
              vendorName: 'AWS',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSetMetric',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Storage - Customer Data S3
    const dataBucket = new s3.Bucket(this, `${tenantId}-data-bucket`, {
      bucketName: `${tenantId}-data`,
      encryptionKey: tenantKmsKey,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      publicReadAccess: false,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // HIPAA Compliance practice
    });

    const rawDataBucket = new s3.Bucket(this, `${tenantId}-raw-data-bucket`, {
      bucketName: `${tenantId}-data`,
      encryptionKey: tenantKmsKey,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      publicReadAccess: false,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // HIPAA Compliance practice
    });

    // Database - Aurora Postgres v2
    const dbCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_14,
      }),
      // Define the instance type (Provisioned)
      writer: rds.ClusterInstance.provisioned('WriterInstance', {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      }),
      readers: [
        rds.ClusterInstance.provisioned('ReaderInstance', {
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
        }),
      ],
      vpc,
      storageEncryptionKey: tenantKmsKey, // Key used for encryption
      storageEncrypted: true,             // Enable encryption
      copyTagsToSnapshot: true,
      defaultDatabaseName: 'default',
    });

    // ECS Fargate
    const ecsFargateCluster = new ecs.Cluster(this, `${tenantId}-cluster`, { vpc });
    const batchECSTaskDefinition = new ecs.FargateTaskDefinition(this, `${tenantId}-api-task`, {
      cpu: 256,
      memoryLimitMiB: 512,
    });


    const batchECSFargateService = new ecs.FargateService(this, `${tenantId}-fargate-svc`, {
      cluster: ecsFargateCluster,
      taskDefinition: batchECSTaskDefinition
    });

    batchECSFargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [dataBucket.bucketArn],
    }));

    batchECSFargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'], // Decrypt is needed for reading, GenerateDataKey for uploading
      resources: [tenantKmsKey.keyArn],
    }));

    // Lambda
    const apiLambda = new lambda.Function(this, `${tenantId}-api-handler`, {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda_src'),
      vpc,
      environment: {
        tenant_id: tenantId,
      },
    });

    apiLambda.role?.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [dataBucket.bucketArn],
    }));

    apiLambda.role?.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'], // Decrypt is needed for reading, GenerateDataKey for uploading
      resources: [tenantKmsKey.keyArn],
    }));

    // 8. Load Balancer (ALB)
    const alb = new elbv2.ApplicationLoadBalancer(this, `${tenantId}-alb`, {
      vpc,
      internetFacing: true,
    });

    // Associate WAF
    new wafv2.CfnWebACLAssociation(this, `${tenantId}-waf-assoc`, {
      resourceArn: alb.loadBalancerArn,
      webAclArn: waf.attrArn,
    });

    // Frontend - S3 + CloudFront
    const frontendBucket = new s3.Bucket(this, `${tenantId}-frontend-bucket`, {
      bucketName: `${tenantId}-frontend`,
      encryptionKey: tenantKmsKey,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      publicReadAccess: false,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // HIPAA Compliance practice
    });

    // Crate origin access identity (need for kms encrpyted bucket)
    // https://stackoverflow.com/questions/60905976/cloudfront-give-access-denied-response-created-through-aws-cdk-python-for-s3-buc
    const originAccessIdentity = new OriginAccessIdentity(this, "originAccessIdentity", {
      comment: `created-for-${tenantId}-frontend`
    });
    frontendBucket.grantRead(originAccessIdentity);

    // --------------------------------------------------------------------------------------
    // Cloudfront frontend for site distription and serving https as S3 Hosting does not serving HTTPS
    // --------------------------------------------------------------------------------------
    // https://github.com/aws-samples/aws-cdk-examples/issues/1084
    const frontendDistribution = new cloudfront.Distribution(this, 'frontendDistribution', {
      defaultBehavior: {
        origin: aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html"
    });

    const frontendOrigin = 'https://' + frontendDistribution.distributionDomainName;
    // Enable below only for local test

    // Add CORS to allow the cloudfront frontend to access the raw data bucket
    // Currently enable GET/POST/PUT/DELETE to retrieve and update content
    rawDataBucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.DELETE],
      allowedOrigins: [frontendOrigin],
    });


    // https://docs.aws.amazon.com/cdk/api/v1/docs/aws-cognito-readme.html
    // --------------------------------------------------------------------------------------
    // AWS Cognito pool for OAuth2 auth
    // --------------------------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, `${tenantId}-userpool`, {
      userPoolName: `${tenantId}-userpool`,
      selfSignUpEnabled: true,
      standardAttributes: {
        email: {
          required: true,
          mutable: true
        }
      },
      removalPolicy: RemovalPolicy.DESTROY,  // When the stack is destroyed, the pool and its info are also destroyed
      userVerification: {
        emailSubject: 'Verify your email for our website!',
        emailBody: 'Thanks for signing up to our website! Your verification code is {####}',
        emailStyle: cognito.VerificationEmailStyle.CODE,
        smsMessage: 'Thanks for signing up to our website! Your verification code is {####}',
      },
      // https://docs.aws.amazon.com/cdk/api/v1/docs/aws-cognito-readme.html
      signInAliases: {            // Allow email as sign up alias please note it can only be configured at initial setup
        email: true
      },
      autoVerify: { email: true },  // Auto verify email
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    });

    // Setup a client for website client
    const frontendAppClient = userPool.addClient('frontend-client', {
      accessTokenValidity: Duration.minutes(60), // Token lifetime
      generateSecret: false,
      preventUserExistenceErrors: true,    // Prevent user existence error to further secure (so will not notify that username exist or not)
      oAuth: {
        flows: {
          implicitCodeGrant: true, // Use implicit grant in this case, as the website does not have a backend
        },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [frontendOrigin],  // For callback and logout, go back to the website
        logoutUrls: [frontendOrigin],
      }
    });

    // domain for cognito hosted endpoint
    // currently use out of box domain from cognito
    const userPoolDomain = userPool.addDomain(`${tenantId}-domain`, {
      cognitoDomain: {
        domainPrefix: `${tenantId}-app`,
      }
    });

    // Setup login Url
    const signInUrl = userPoolDomain.signInUrl(frontendAppClient, {
      redirectUri: frontendOrigin, // must be a URL configured under 'callbackUrls' with the client
    });


    // Print output
    new CfnOutput(this, `${tenantId}-userPoolId`, { value: userPool.userPoolId });
    new CfnOutput(this, `${tenantId}-frontendUrl`, { value: frontendOrigin });
    new CfnOutput(this, `${tenantId}-frontendSignInUrl`, { value: signInUrl });
    new CfnOutput(this, `${tenantId}-frontendBucket`, { value: frontendBucket.bucketName });
  }
}