import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

import {
  aws_cloudfront_origins,
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  StackProps,
  Tags
} from "aws-cdk-lib";
import {SHARE_SERVICE_TENANT_ID, TenantStackConfig} from "./StackConfig";
import {OriginAccessIdentity} from "aws-cdk-lib/aws-cloudfront";
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'

export class TenantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, tenantStackConfig: TenantStackConfig, props: StackProps) {
    super(scope, id, props);

    const tenantId = tenantStackConfig.tenantId;
    const environment = tenantStackConfig.environment;

    // import the ecr arn from exporting stack `share-service-stack`
    const shareServiceKMSKey = kms.Key.fromKeyArn(
      this, `${SHARE_SERVICE_TENANT_ID}-${environment}-${this.region}-kmsKey`,
      cdk.Fn.importValue(`${SHARE_SERVICE_TENANT_ID}-${environment}-${this.region}-kmsKeyArn`),
    )
    // need to use fromRepositoryAttributes with repositoryArn and repositoryName to satisfy late binding issue
    const apiSvcECR = ecr.Repository.fromRepositoryAttributes(
      this, `${SHARE_SERVICE_TENANT_ID}-${environment}-${this.region}-apiSvcECR`,
      {repositoryArn:cdk.Fn.importValue(`${SHARE_SERVICE_TENANT_ID}-${environment}-${this.region}-apiSvcECRArn`),
        repositoryName: cdk.Fn.importValue(`${SHARE_SERVICE_TENANT_ID}-${environment}-${this.region}-apiSvcECRName`)
      });

    // need to use fromRepositoryAttributes with repositoryArn and repositoryName to satisfy late binding issue
    const shareServiceIngestBucket = s3.Bucket.fromBucketArn(
      this, `${SHARE_SERVICE_TENANT_ID}-${environment}-${this.region}-ingestBucket`,
      cdk.Fn.importValue(`${SHARE_SERVICE_TENANT_ID}-${environment}-${this.region}-ingestBucketArn`),
    );

    // Apply to everything in the stack
    Tags.of(this).add('tenantId', tenantId);
    Tags.of(this).add('environment', environment);
    Tags.of(this).add('region', this.region);

    // Encryption - Custom KMS Key
    const tenantKmsKey = new kms.Key(this, `${tenantId}-${this.region}-key`, {
      alias: `alias/tenant-${tenantId}-key`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const tenantIngestS3SQS = new sqs.Queue(this, `${tenantId}-${this.region}-ingestS3SQS`, {
      visibilityTimeout: cdk.Duration.seconds(300),
      encryptionMasterKey: tenantKmsKey
    });

    // Add events to send to SQS
    const scanRule = new events.Rule(this, `${tenantId}-${this.region}-malwareScanRule`, {
      eventPattern: {
        source: ['aws.guardduty'],
        detailType: ['GuardDuty Malware Scan Results'],
        detail: {
          s3ObjectDetails: {
            bucketName: [shareServiceIngestBucket.bucketName],
            // Use prefix matching on the object key
            key: [{ prefix: `${tenantId}/` }]
          }
        }
      }
    });

    scanRule.addTarget(new targets.SqsQueue(tenantIngestS3SQS));

    // Allow the entire account to use this key,
    // provided the IAM principal also has permissions.
    tenantKmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Enable IAM User Permissions',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()], // Trust the account's IAM policies
      actions: ['kms:*'],
      resources: ['*'],
    }));

    // Specific Service permission
    tenantKmsKey.addToResourcePolicy(new iam.PolicyStatement({
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

    // Networking
    const vpc = new ec2.Vpc(this, `${tenantId}-${environment}-${this.region}-vpc`, {
      natGateways: 0, // disable public access from NAT gateway for now
      maxAzs: 2,
      enableDnsSupport: true, // explict set to allow VPC/Gateway endpoint resolution
      enableDnsHostnames: true, // explict set to allow VPC/Gateway endpoint resolution
      subnetConfiguration: [
        { name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 20 // 4,096 IPs for public (Load Balancers/NATs)
        },
        { name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 20 // 4,096 IPs for private services
        },
      ],
    });

    // Create the Bedrock Runtime VPC Endpoint (Interface Endpoint)
    const bedrockRuntimeEndpoint = vpc.addInterfaceEndpoint(`${tenantId}-${environment}-${this.region}-bedrockRuntimeEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const s3Endpoint = vpc.addGatewayEndpoint(`${tenantId}-${environment}-${this.region}-s3Endpoint`, {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Get the Prefix List ID for S3 through  CDK  automatically
    const s3PrefixList = ec2.PrefixList.fromLookup(this, `${tenantId}-${environment}-${this.region}-s3PrefixList`, {
      prefixListName: `com.amazonaws.${this.region}.s3`,
    });

    vpc.addInterfaceEndpoint(`${tenantId}-${environment}-eventBridgeEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE,
    });

    const cloudwatchLogsEndpoint = vpc.addInterfaceEndpoint(`${tenantId}-${environment}-${this.region}-cloudWatchLogsEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });

    vpc.addInterfaceEndpoint(`${tenantId}-${environment}-cognitoIDPEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.COGNITO_IDP,
    });

    // Need KMS for docker image
    const kmsEndpoint = vpc.addInterfaceEndpoint(`${tenantId}-${environment}-${this.region}-kmsEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
    });

    // ECS Docker Image URI pull
    const ecrDockerEndpoint = vpc.addInterfaceEndpoint(`${tenantId}-${environment}-${this.region}-ecrDockerEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    // Need S3 gateway endpoint to be created for ecr docker image pull success
    // But s3 gateway endpoint is not directly depend by any resources (as SG depends on prefix rather than resources),
    // so need to explict call out the dependency for cloudformation to resolve correctly
    ecrDockerEndpoint.node.addDependency(s3Endpoint);

    // Need by ECS to search for docker image
    const ecrEndpoint = vpc.addInterfaceEndpoint(`${tenantId}-${environment}-${this.region}-ecrEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    // Need by ECS to get secret
    const secretManagerEndpoint = vpc.addInterfaceEndpoint(`${tenantId}-${environment}-${this.region}-secretManager`, {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    // Need by ECS to get secret
    const sqsEndpoint = vpc.addInterfaceEndpoint(`${tenantId}-${environment}-${this.region}-sqs`, {
      service: ec2.InterfaceVpcEndpointAwsService.SQS,
    });

    const albSG = new ec2.SecurityGroup(this, `${tenantId}-${environment}-${this.region}-alb-sg`, {
      vpc,
      description: 'Security group for ALB to perform finite control when necessary',
    });

    // Load Balancer (ALB)
    const alb = new elbv2.ApplicationLoadBalancer(this, `${tenantId}-${environment}-${this.region}-pub-alb`, {
      vpc,
      internetFacing: true, // open to public
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSG,
    });

    // Connect ALB to ECS
    const listener = alb.addListener(`${tenantId}-${environment}-${this.region}-pubAlbListener`, {
      port: 80,});

    // TODO: Update to HTTPS url once have proper domain and cert
    // THis is not secure currently
    //const apiSvcUrl = `https://${alb.loadBalancerDnsName}`
    const apiSvcUrl = `http://localhost:8080`

    const cognitoCallbackUrl = `${apiSvcUrl}/callback`

    // https://docs.aws.amazon.com/cdk/api/v1/docs/aws-cognito-readme.html
    // --------------------------------------------------------------------------------------
    // AWS Cognito pool for OAuth2 auth
    // --------------------------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, `${tenantId}-${environment}-${this.region}-userpool`, {
      userPoolName: `${tenantId}-${environment}-userpool`,
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

    // domain for cognito hosted endpoint
    // currently use out of box domain from cognito
    const userPoolDomain = userPool.addDomain(`${tenantId}-${environment}-${this.region}-domain`, {
      cognitoDomain: {
        domainPrefix: `${tenantId}-${environment}-${this.region}-domain`,
      }
    });

    const apiSvcClient = userPool.addClient(`${tenantId}-${environment}-${this.region}-apiSvcClient`, {
      oAuth: {
        flows: {
          authorizationCodeGrant: true, // Required for backend svc flow
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [cognitoCallbackUrl], // Update for later usage
      },
      generateSecret: true,
    });

    const apiSvcClientSecret = new secretsmanager.Secret(this, `${tenantId}-${environment}-${this.region}-${this.region}-apiSvcClientSecret`, {
      secretObjectValue: {
        // Map the Cognito values to keys inside the JSON secret
        COGNITO_CLIENT_ID: SecretValue.unsafePlainText(apiSvcClient.userPoolClientId),
        COGNITO_CLIENT_SECRET: apiSvcClient.userPoolClientSecret,
      },
      encryptionKey: tenantKmsKey,
    });

    // // Security - WAF (Simplified HIPAA-like set)
    // const waf = new wafv2.CfnWebACL(this, `${tenantId}-${environment}-${this.region}-waf`, {
    //   defaultAction: { allow: {} },
    //   scope: 'REGIONAL',
    //   visibilityConfig: {
    //     cloudWatchMetricsEnabled: true,
    //     metricName: `${tenantId}-${environment}-${this.region}-waf-metric`,
    //     sampledRequestsEnabled: true,
    //   },
    //   rules: [
    //     {
    //       name: 'AWS-AWSManagedRulesCommonRuleSet',
    //       priority: 1,
    //       overrideAction: { none: {} },
    //       statement: {
    //         managedRuleGroupStatement: {
    //           name: 'AWSManagedRulesCommonRuleSet',
    //           vendorName: 'AWS',
    //         },
    //       },
    //       visibilityConfig: {
    //         cloudWatchMetricsEnabled: true,
    //         metricName: 'CommonRuleSetMetric',
    //         sampledRequestsEnabled: true,
    //       },
    //     },
    //   ],
    // });
    // // Associate WAF
    // new wafv2.CfnWebACLAssociation(this, `${tenantId}-${environment}-${this.region}-waf-assoc`, {
    //   resourceArn: alb.loadBalancerArn,
    //   webAclArn: waf.attrArn,
    // });
    //

    // Storage - Customer Data S3
    const tenantDataBucket = new s3.Bucket(this, `${tenantId}-${environment}-${this.region}-data-bucket`, {
      bucketName: `${tenantId}-${environment}-data`,
      encryptionKey: tenantKmsKey,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      publicReadAccess: false,
      enforceSSL: true,
      bucketKeyEnabled: true, // Reduces KMS costs
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,  // setup for development, should not use in production
      autoDeleteObjects: true, // setup for development, should not use in production
    });

    // Database - Aurora Postgres v2
    const dbCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_14,
      }),
      // Define the instance type (Provisioned)
      writer: rds.ClusterInstance.provisioned('WriterInstance', {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      }),
      readers: [
        rds.ClusterInstance.provisioned('ReaderInstance', {
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        }),
      ],
      vpc,
      storageEncryptionKey: tenantKmsKey, // Key used for encryption
      storageEncrypted: true,             // Enable encryption
      copyTagsToSnapshot: true,
      defaultDatabaseName: 'default',
    });

    const apiSvcSG = new ec2.SecurityGroup(this, '${tenantId}-${environment}-${this.region}-apiSvcSg', {
      vpc,
      allowAllOutbound: false, // disable default output
      description: 'Security group for API service with restricted egress',
    });

    // ECS Fargate
    const ecsFargateCluster = new ecs.Cluster(this, `${tenantId}-${environment}-${this.region}-cluster`, { vpc });
    const apiSvcECSTaskDefinition = new ecs.FargateTaskDefinition(this, `${tenantId}-${environment}-${this.region}-apiSvcTask`, {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    const apiSvcLogGroup = new logs.LogGroup(this, 'apiLogGroup', {
      logGroupName: `/ecs/${tenantId}-${environment}-${this.region}-api-service`,
      encryptionKey: tenantKmsKey, // Enables the CMK encryption
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Add a container to the task definition using an image from a registry
    const apiSvcContainer = apiSvcECSTaskDefinition.addContainer(`${tenantId}-${environment}-${this.region}-apiSvcContainer`, {
      // Use ecs.ContainerImage.fromRegistry() to specify the image
      image: ecs.ContainerImage.fromEcrRepository(apiSvcECR, tenantStackConfig.services.api.image.tag),
      logging: ecs.AwsLogDriver.awsLogs({
        streamPrefix: "apiSvcTaskLogs",
        logGroup: apiSvcLogGroup,
      }),
      portMappings: [
        {
          containerPort: 8080,
          protocol: ecs.Protocol.TCP,
        },
      ],
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -f http://localhost:8080/api/v1/health || exit 1"
        ],
        // Configure health check parameters
        interval: cdk.Duration.seconds(30), // How often to run the check
        timeout: cdk.Duration.seconds(5),   // How long to wait for the command to finish
        retries: 3,                         // Number of times to retry before marking as unhealthy
        startPeriod: cdk.Duration.seconds(10), // Grace period for the container to start up
      },
      environment:{
        "AWS_REGION": this.region,
        "COGNITO_USER_POOL_ID": userPool.userPoolId,
        "COGNITO_DOMAIN": userPoolDomain.baseUrl(),
        "COGNITO_REDIRECT_URL": cognitoCallbackUrl,
        "BEDROCK_MODEL_ID": tenantStackConfig.services.api.bedrockModelId,
        "S3_SHARE_SERVICE_INGEST_BUCKET_NAME": shareServiceIngestBucket.bucketName,
        "S3_TENANT_DATA_BUCKET_NAME": tenantDataBucket.bucketName,
        "SQS_TENANT_INGEST_S3_QUEUE_URL": tenantIngestS3SQS.queueUrl,
        "KMS_TENANT_KEY_ARN": tenantKmsKey.keyArn,
        "TENANT_ID": tenantId,
        DB_HOST: dbCluster.clusterEndpoint.hostname,
        DB_NAME: 'myapp',
        DB_PORT: '5432',
        DB_USER: 'postgres',
      },
      // Use secrets for sensitive data
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'password'),
        COGNITO_CLIENT_ID: ecs.Secret.fromSecretsManager(apiSvcClientSecret, 'COGNITO_CLIENT_ID'),
        COGNITO_CLIENT_SECRET: ecs.Secret.fromSecretsManager(apiSvcClientSecret, 'COGNITO_CLIENT_SECRET'),
      },
    });

    const apiECSFargateService = new ecs.FargateService(this, `${tenantId}-${environment}-${this.region}-api-fargate-svc`, {
      cluster: ecsFargateCluster,
      taskDefinition: apiSvcECSTaskDefinition,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false, // ensure stay in private
      securityGroups: [apiSvcSG] // assign explict sg
    });

    // Allow get/delete/put
    // The kms key is on next, so not directly use s3 grant access method
    apiECSFargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [tenantDataBucket.bucketArn],
    }));

    // Allow get/delete/put (put is because to generate sts token)
    // The kms key is on next, so not directly use s3 grant access method
    apiECSFargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [shareServiceIngestBucket.bucketArn],
    }));

    // For access to different services encrypt with kms
    apiECSFargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:CreateGrant', 'kms:RetireGrant', 'kms:GenerateDataKey'], // Decrypt is needed for reading, GenerateDataKey for uploading
      resources: [tenantKmsKey.keyArn, shareServiceKMSKey.keyArn],
    }));

    apiECSFargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream'
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/${tenantStackConfig.services.api.bedrockModelId}`
      ],
    }));

    // task federation role
    apiECSFargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:GetFederatedToken'],
      resources: ['*'],
    }));

    listener.addTargets('apiSvcTarget', {
      port: 8080,
      targets: [apiECSFargateService],
      healthCheck: {
        path: '/api/v1/health', // From the services/api golang code
        interval: cdk.Duration.seconds(30),
      },
    });


    // Explict allow
    apiSvcSG.connections.allowFrom(alb, ec2.Port.tcp(8080), 'Allow ingress connection from ALB');
    apiSvcSG.connections.allowTo(ecrDockerEndpoint, ec2.Port.tcp(443), 'Allow egress to ECR Docker VPC endpoint');
    apiSvcSG.connections.allowTo(ecrEndpoint, ec2.Port.tcp(443), 'Allow egress to ECR API VPC endpoint');
    apiSvcSG.connections.allowTo(kmsEndpoint, ec2.Port.tcp(443), 'Allow egress to KMS VPC endpoint');
    apiSvcSG.connections.allowTo(cloudwatchLogsEndpoint, ec2.Port.tcp(443), 'Allow egress to Cloudwatch Logs VPC endpoint');
    apiSvcSG.connections.allowTo(secretManagerEndpoint, ec2.Port.tcp(443), 'Allow egress to Secret Manager VPC endpoint');
    apiSvcSG.connections.allowTo(bedrockRuntimeEndpoint, ec2.Port.tcp(443), 'Allow egress to Bedrock Runtime VPC endpoint');
    apiSvcSG.connections.allowTo(sqsEndpoint, ec2.Port.tcp(443), 'Allow egress to SQS VPC endpoint');

    apiSvcSG.addEgressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.udp(53), 'Allow DNS lookups');
    // Add an egress rule to allow HTTPS traffic to S3 using the prefix list
    apiSvcSG.addEgressRule(ec2.Peer.prefixList(s3PrefixList.prefixListId), ec2.Port.tcp(443), 'Allow outbound HTTPS to S3 Gateway endpoint through prefix');

    // allow connection to database
    dbCluster.connections.allowDefaultPortFrom(apiECSFargateService);

    // Grant the ECS task permission to read the DB password from Secrets Manager
    dbCluster.secret?.grantRead(apiECSFargateService.taskDefinition.taskRole);


    // Frontend - S3 + CloudFront
    const frontendBucket = new s3.Bucket(this, `${tenantId}-${environment}-${this.region}-frontend-bucket`, {
      bucketName: `${tenantId}-${environment}-${this.region}-frontend`,
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
      comment: `created-for-${tenantId}-${environment}-${this.region}-frontend`
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


    // Setup login Url
    const signInUrl = userPoolDomain.signInUrl(frontendAppClient, {
      redirectUri: frontendOrigin, // must be a URL configured under 'callbackUrls' with the client
    });

    // Print output
    new CfnOutput(this, `${tenantId}-${environment}-${this.region}-userPoolId`, { value: userPool.userPoolId });
    new CfnOutput(this, `${tenantId}-${environment}-${this.region}-apiSvcUrl`, { value: apiSvcUrl });
    // new CfnOutput(this, `${tenantId}-${environment}-${this.region}-frontendUrl`, { value: frontendOrigin });
    // new CfnOutput(this, `${tenantId}-${environment}-${this.region}-frontendSignInUrl`, { value: signInUrl });
    // new CfnOutput(this, `${tenantId}-${environment}-${this.region}-frontendBucket`, { value: frontendBucket.bucketName });
  }
}