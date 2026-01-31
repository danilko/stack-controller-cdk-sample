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
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import {aws_iam, StackProps} from "aws-cdk-lib";
import {EcsApplication} from "aws-cdk-lib/aws-codedeploy";
import {TenantStackConfig} from "./StackConfig";


export class TenantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, tenantStackConfig: TenantStackConfig, props: StackProps) {
    super(scope, id, props);

    const tenantId = tenantStackConfig.tenantId;

    // Encryption - Custom KMS Key
    const shareServiceKmsKey = new kms.Key(this, `${tenantId}-key`, {
      alias: `alias/${tenantId}-service-key`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep the key even if stack is deleted
    });

  }
}