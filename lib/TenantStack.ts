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
import {aws_cloudfront_origins, CfnOutput, Duration, RemovalPolicy, SecretValue, StackProps, Tags} from "aws-cdk-lib";
import {TenantStackConfig} from "./StackConfig";
import {OriginAccessIdentity} from "aws-cdk-lib/aws-cloudfront";
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'


export class TenantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, tenantStackConfig: TenantStackConfig, props: StackProps) {
    super(scope, id, props);

    const tenantId = tenantStackConfig.tenantId;

    // import the ecr arn from exporting stack `share-service-stack`
    const shareServiceKMSKey = kms.Key.fromKeyArn(
      this, 'share-service-kmsKeyArn',
      cdk.Fn.importValue('share-service-kmsKeyArn'),
    )
    // need to use fromRepositoryAttributes with repositoryArn and repositoryName to satisfy late binding issue
    const apiServiceECR = ecr.Repository.fromRepositoryAttributes(
      this, 'share-service-apiServiceECR',
      {repositoryArn:cdk.Fn.importValue('share-service-apiServiceECRArn'),
        repositoryName: cdk.Fn.importValue('share-service-apiServiceECRName')
      });

    // Apply to everything in the stack
    Tags.of(this).add('tenantId', tenantId);


    // Encryption - Custom KMS Key
    const tenantKmsKey = new kms.Key(this, `${tenantId}-key`, {
      alias: `alias/${tenantId}-key`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

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
    const vpc = new ec2.Vpc(this, `${tenantId}-vpc`, {
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
    vpc.addInterfaceEndpoint('bedrockRuntimeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const s3Endpoint = vpc.addGatewayEndpoint('s3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Get the Prefix List ID for S3 through  CDK  automatically
    const s3PrefixList = ec2.PrefixList.fromLookup(this, 'S3PrefixList', {
      prefixListName: `com.amazonaws.${this.region}.s3`,
    });

    vpc.addInterfaceEndpoint('eventBridgeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE,
    });

    const cloudwatchLogsEndpoint = vpc.addInterfaceEndpoint('cloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });

    vpc.addInterfaceEndpoint('cognitoIDPEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.COGNITO_IDP,
    });

    // Need KMS for docker image
    const kmsEndpoint = vpc.addInterfaceEndpoint('kmsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
    });

    // ECS Docker Image URI pull
    const ecrDockerEndpoint = vpc.addInterfaceEndpoint('ecrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    // Need S3 gateway endpoint to be created for ecr docker image pull success
    // But s3 gateway endpoint is not directly depend by any resources (as SG depends on prefix rather than resources),
    // so need to explict call out the dependency for cloudformation to resolve correctly
    ecrDockerEndpoint.node.addDependency(s3Endpoint);

    // Need by ECS to search for docker image
    const ecrEndpoint = vpc.addInterfaceEndpoint('ecrEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    // Need by ECS to get secret
    const secretManagerEndpoint = vpc.addInterfaceEndpoint('secretManager', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });


    // Load Balancer (ALB)
    const alb = new elbv2.ApplicationLoadBalancer(this, `${tenantId}-public-alb`, {
      vpc,
      internetFacing: true, // open to public
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    // Connect ALB to ECS
    const listener = alb.addListener(`listener`, { port: 80 });

    // TODO: Update to HTTPS url once have proper domain and cert
    // THis is not secure currently
    //const cognitoCallbackUrl = `http://${alb.loadBalancerDnsName}/callback`
    const cognitoCallbackUrl = `http://localhost:8080/callback`
    
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

    // domain for cognito hosted endpoint
    // currently use out of box domain from cognito
    const userPoolDomain = userPool.addDomain(`${tenantId}-domain`, {
      cognitoDomain: {
        domainPrefix: `${tenantId}-${this.region}-app`,
      }
    });

    const appSvcClient = userPool.addClient(`${tenantId}-appSvcClient`, {
      oAuth: {
        flows: {
          authorizationCodeGrant: true, // Required for backend svc flow
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [cognitoCallbackUrl], // Update for later usage
      },
      generateSecret: true,
    });

    const appSvcClientSecret = new secretsmanager.Secret(this, `${tenantId}-appSvcClientSecret`, {
      secretObjectValue: {
        // Map the Cognito values to keys inside the JSON secret
        COGNITO_CLIENT_ID: SecretValue.unsafePlainText(appSvcClient.userPoolClientId),
        COGNITO_CLIENT_SECRET: appSvcClient.userPoolClientSecret,
      },
      encryptionKey: tenantKmsKey,
    });

    // // Security - WAF (Simplified HIPAA-like set)
    // const waf = new wafv2.CfnWebACL(this, `${tenantId}-waf`, {
    //   defaultAction: { allow: {} },
    //   scope: 'REGIONAL',
    //   visibilityConfig: {
    //     cloudWatchMetricsEnabled: true,
    //     metricName: `${tenantId}-waf-metric`,
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
    //
    // // Storage - Customer Data S3
    // const dataBucket = new s3.Bucket(this, `${tenantId}-${this.region}-data-bucket`, {
    //   bucketName: `${tenantId}-data`,
    //   encryptionKey: tenantKmsKey,
    //   objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
    //   publicReadAccess: false,
    //   enforceSSL: true,
    //   blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    //   removalPolicy: cdk.RemovalPolicy.RETAIN, // HIPAA Compliance practice
    // });
    //
    // const rawDataBucket = new s3.Bucket(this, `${tenantId}-${this.region}-raw-data-bucket`, {
    //   bucketName: `${tenantId}-raw-data`,
    //   encryptionKey: tenantKmsKey,
    //   objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
    //   publicReadAccess: false,
    //   enforceSSL: true,
    //   blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    //   removalPolicy: cdk.RemovalPolicy.RETAIN, // HIPAA Compliance practice
    // });

    // // Database - Aurora Postgres v2
    // const dbCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
    //   engine: rds.DatabaseClusterEngine.auroraPostgres({
    //     version: rds.AuroraPostgresEngineVersion.VER_15_14,
    //   }),
    //   // Define the instance type (Provisioned)
    //   writer: rds.ClusterInstance.provisioned('WriterInstance', {
    //     instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
    //   }),
    //   readers: [
    //     rds.ClusterInstance.provisioned('ReaderInstance', {
    //       instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
    //     }),
    //   ],
    //   vpc,
    //   storageEncryptionKey: tenantKmsKey, // Key used for encryption
    //   storageEncrypted: true,             // Enable encryption
    //   copyTagsToSnapshot: true,
    //   defaultDatabaseName: 'default',
    // });



    const apiSvcSG = new ec2.SecurityGroup(this, '${tenantId}-api-svc-sg', {
      vpc,
      allowAllOutbound: false, // disable default output
      description: 'Security group for API service with restricted egress',
    });

    // ECS Fargate
    const ecsFargateCluster = new ecs.Cluster(this, `${tenantId}-cluster`, { vpc });
    const apiSvcECSTaskDefinition = new ecs.FargateTaskDefinition(this, `${tenantId}-api-svc-task`, {
      cpu: 256,
      memoryLimitMiB: 512,
    });


    const apiSvcLogGroup = new logs.LogGroup(this, 'apiLogGroup', {
      logGroupName: `/ecs/${tenantId}-api-service`,
      encryptionKey: tenantKmsKey, // Enables the CMK encryption
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Add a container to the task definition using an image from a registry
    const apiSvcContainer = apiSvcECSTaskDefinition.addContainer('api-svc-container', {
      // Use ecs.ContainerImage.fromRegistry() to specify the image
      image: ecs.ContainerImage.fromEcrRepository(apiServiceECR, tenantStackConfig.services.api.image.tag),
      logging: ecs.AwsLogDriver.awsLogs({
        streamPrefix: "api-task-logs",
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
      },
      // Use secrets for sensitive data
      secrets: {
        COGNITO_CLIENT_ID: ecs.Secret.fromSecretsManager(appSvcClientSecret, 'COGNITO_CLIENT_ID'),
        COGNITO_CLIENT_SECRET: ecs.Secret.fromSecretsManager(appSvcClientSecret, 'COGNITO_CLIENT_SECRET'),
      },
    });

    const apiECSFargateService = new ecs.FargateService(this, `${tenantId}-api-fargate-svc`, {
      cluster: ecsFargateCluster,
      taskDefinition: apiSvcECSTaskDefinition,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false, // ensure stay in private
      securityGroups: [apiSvcSG] // assign explict sg
    });

    //
    // apiECSFargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
    //   actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
    //   resources: [dataBucket.bucketArn],
    // }));

    apiECSFargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:CreateGrant', 'kms:RetireGrant', 'kms:GenerateDataKey'], // Decrypt is needed for reading, GenerateDataKey for uploading
      resources: [tenantKmsKey.keyArn, shareServiceKMSKey.keyArn],
    }));


    apiECSFargateService.taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream'
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`
      ],
    }));



    listener.addTargets('apiSvcTarget', {
      port: 8080,
      targets: [apiECSFargateService],
      healthCheck: {
        path: '/api/v1/health', // From the services/api golang code
        interval: cdk.Duration.seconds(30),
      },
    });


    apiSvcSG.connections.allowFrom(alb, ec2.Port.tcp(8080), 'Allow ingress connection from ALB');
    apiSvcSG.connections.allowTo(ecrDockerEndpoint, ec2.Port.tcp(443), 'Allow egress to ECR Docker VPC endpoint');
    apiSvcSG.connections.allowTo(ecrEndpoint, ec2.Port.tcp(443), 'Allow egress to ECR API VPC endpoint');
    apiSvcSG.connections.allowTo(kmsEndpoint, ec2.Port.tcp(443), 'Allow egress to KMS VPC endpoint');
    apiSvcSG.connections.allowTo(cloudwatchLogsEndpoint, ec2.Port.tcp(443), 'Allow egress to Cloudwatch Logs VPC endpoint');
    apiSvcSG.connections.allowTo(secretManagerEndpoint, ec2.Port.tcp(443), 'Allow egress to Secret Manager VPC endpoint');
    apiSvcSG.addEgressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.udp(53), 'Allow DNS lookups');
    // Add an egress rule to allow HTTPS traffic to S3 using the prefix list
    apiSvcSG.addEgressRule(ec2.Peer.prefixList(s3PrefixList.prefixListId), ec2.Port.tcp(443), 'Allow outbound HTTPS to S3 Gateway endpoint through prefix');

    // // Associate WAF
    // new wafv2.CfnWebACLAssociation(this, `${tenantId}-waf-assoc`, {
    //   resourceArn: alb.loadBalancerArn,
    //   webAclArn: waf.attrArn,
    // });
    //
    // // Frontend - S3 + CloudFront
    // const frontendBucket = new s3.Bucket(this, `${tenantId}-frontend-bucket`, {
    //   bucketName: `${tenantId}-frontend`,
    //   encryptionKey: tenantKmsKey,
    //   objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
    //   publicReadAccess: false,
    //   enforceSSL: true,
    //   blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    //   removalPolicy: cdk.RemovalPolicy.RETAIN, // HIPAA Compliance practice
    // });
    //
    // // Crate origin access identity (need for kms encrpyted bucket)
    // // https://stackoverflow.com/questions/60905976/cloudfront-give-access-denied-response-created-through-aws-cdk-python-for-s3-buc
    // const originAccessIdentity = new OriginAccessIdentity(this, "originAccessIdentity", {
    //   comment: `created-for-${tenantId}-frontend`
    // });
    // frontendBucket.grantRead(originAccessIdentity);
    //
    // // --------------------------------------------------------------------------------------
    // // Cloudfront frontend for site distription and serving https as S3 Hosting does not serving HTTPS
    // // --------------------------------------------------------------------------------------
    // // https://github.com/aws-samples/aws-cdk-examples/issues/1084
    // const frontendDistribution = new cloudfront.Distribution(this, 'frontendDistribution', {
    //   defaultBehavior: {
    //     origin: aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
    //     viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    //   },
    //   defaultRootObject: "index.html"
    // });
    //
    // const frontendOrigin = 'https://' + frontendDistribution.distributionDomainName;
    // // Enable below only for local test
    //
    // // Add CORS to allow the cloudfront frontend to access the raw data bucket
    // // Currently enable GET/POST/PUT/DELETE to retrieve and update content
    // rawDataBucket.addCorsRule({
    //   allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.DELETE],
    //   allowedOrigins: [frontendOrigin],
    // });
    //


    //
    // // Setup a client for website client
    // const frontendAppClient = userPool.addClient('frontend-client', {
    //   accessTokenValidity: Duration.minutes(60), // Token lifetime
    //   generateSecret: false,
    //   preventUserExistenceErrors: true,    // Prevent user existence error to further secure (so will not notify that username exist or not)
    //   oAuth: {
    //     flows: {
    //       implicitCodeGrant: true, // Use implicit grant in this case, as the website does not have a backend
    //     },
    //     scopes: [cognito.OAuthScope.OPENID],
    //     callbackUrls: [frontendOrigin],  // For callback and logout, go back to the website
    //     logoutUrls: [frontendOrigin],
    //   }
    // });
    //
    //
    // // Setup login Url
    // const signInUrl = userPoolDomain.signInUrl(frontendAppClient, {
    //   redirectUri: frontendOrigin, // must be a URL configured under 'callbackUrls' with the client
    // });

    // Print output
    // new CfnOutput(this, `${tenantId}-userPoolId`, { value: userPool.userPoolId });
    // new CfnOutput(this, `${tenantId}-frontendUrl`, { value: frontendOrigin });
    // new CfnOutput(this, `${tenantId}-frontendSignInUrl`, { value: signInUrl });
    // new CfnOutput(this, `${tenantId}-frontendBucket`, { value: frontendBucket.bucketName });
  }
}