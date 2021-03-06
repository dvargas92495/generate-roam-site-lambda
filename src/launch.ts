import AWS from "aws-sdk";
import { Handler } from "aws-lambda";
import namor from "namor";
import { createLogStatus, cf } from "./common";

const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

const lambda = new AWS.Lambda({ apiVersion: "2015-03-31", credentials });

export const handler: Handler<{
  roamGraph: string;
  domain: string;
  email: string;
}> = async ({ roamGraph, domain, email }) => {
  const logStatus = createLogStatus(roamGraph);

  await logStatus("ALLOCATING HOST");
  const domainParts = domain.split(".");
  const HostedZoneName = domainParts.slice(domainParts.length - 2).join(".");
  const HostedZoneId = { "Fn::GetAtt": ["HostedZone", "Id"] };
  const roamjsSubdomain = namor.generate({ words: 3, saltLength: 0 });
  const roamjsDomain = `${roamjsSubdomain}.roamjs.com`;

  await logStatus("CREATING WEBSITE");
  const Tags = [
    {
      Key: "Application",
      Value: "Roam JS Extensions",
    },
  ];
  const AliasTarget = {
    HostedZoneId: "Z2FDTNDATAQYW2",
    DNSName: {
      "Fn::GetAtt": ["CloudfrontDistribution", "DomainName"],
    },
  };
  const Input = JSON.stringify({
    roamGraph,
    domain,
  });

  await cf
    .createStack({
      NotificationARNs: [process.env.SNS_TOPIC_ARN],
      Parameters: [
        {
          ParameterKey: "Email",
          ParameterValue: email,
        },
      ],
      RoleARN: process.env.CLOUDFORMATION_ROLE_ARN,
      StackName: `roamjs-${roamGraph}`,
      Tags,
      TemplateBody: JSON.stringify({
        Parameters: {
          Email: {
            Type: "String",
          },
        },
        Resources: {
          AcmCertificate: {
            Type: "AWS::CertificateManager::Certificate",
            Properties: {
              DomainName: domain,
              SubjectAlternativeNames: [roamjsDomain],
              Tags,
              ValidationMethod: "DNS",
              DomainValidationOptions: [
                {
                  DomainName: domain,
                  HostedZoneId,
                },
                {
                  DomainName: roamjsDomain,
                  HostedZoneId: process.env.ROAMJS_ZONE_ID,
                },
              ],
            },
          },
          CloudfrontDistribution: {
            Type: "AWS::CloudFront::Distribution",
            Properties: {
              DistributionConfig: {
                Aliases: [domain, roamjsDomain],
                Comment: `CloudFront CDN for ${domain}`,
                CustomErrorResponses: [
                  {
                    ErrorCode: 404,
                    ResponseCode: 200,
                    ResponsePagePath: "/404.html",
                  },
                  {
                    ErrorCode: 403,
                    ResponseCode: 200,
                    ResponsePagePath: "/index.html",
                  },
                ],
                DefaultCacheBehavior: {
                  AllowedMethods: ["GET", "HEAD", "OPTIONS"],
                  CachedMethods: ["GET", "HEAD", "OPTIONS"],
                  Compress: true,
                  DefaultTTL: 86400,
                  ForwardedValues: {
                    Cookies: {
                      Forward: "none",
                    },
                    QueryString: false,
                  },
                  LambdaFunctionAssociations: [
                    {
                      EventType: "origin-request",
                      IncludeBody: false,
                      LambdaFunctionARN: process.env.ORIGIN_LAMBDA_ARN,
                    },
                  ],
                  MaxTTL: 31536000,
                  MinTTL: 0,
                  TargetOriginId: `S3-${domain}`,
                  ViewerProtocolPolicy: "redirect-to-https",
                },
                DefaultRootObject: `${roamGraph}/index.html`,
                Enabled: true,
                IPV6Enabled: true,
                Origins: [
                  {
                    CustomOriginConfig: {
                      HTTPPort: 80,
                      HTTPSPort: 443,
                      OriginProtocolPolicy: "http-only",
                      OriginSSLProtocols: ["TLSv1", "TLSv1.2"],
                    },
                    DomainName: process.env.S3_WEBSITE_ENDPOINT,
                    Id: `S3-${domain}`,
                    OriginCustomHeaders: [
                      {
                        HeaderName: "User-Agent",
                        HeaderValue: process.env.CLOUDFRONT_SECRET,
                      },
                      {
                        HeaderName: "X-Roam-Graph",
                        HeaderValue: roamGraph,
                      },
                    ],
                  },
                ],
                PriceClass: "PriceClass_All",
                ViewerCertificate: {
                  AcmCertificateArn: {
                    Ref: "AcmCertificate",
                  },
                  MinimumProtocolVersion: "TLSv1_2016",
                  SslSupportMethod: "sni-only",
                },
              },
              Tags,
            },
          },
          HostedZone: {
            Type: "AWS::Route53::HostedZone",
            Properties: {
              HostedZoneConfig: {
                Comment: `RoamJS Static Site For ${roamGraph}`,
              },
              Name: HostedZoneName,
            },
          },
          Route53ARecord: {
            Type: "AWS::Route53::RecordSet",
            Properties: {
              AliasTarget,
              HostedZoneId,
              Name: domain,
              Type: "A",
            },
          },
          Route53AAAARecord: {
            Type: "AWS::Route53::RecordSet",
            Properties: {
              AliasTarget,
              HostedZoneId,
              Name: domain,
              Type: "AAAA",
            },
          },
          Route53ARecordRoamJS: {
            Type: "AWS::Route53::RecordSet",
            Properties: {
              AliasTarget,
              HostedZoneId: process.env.ROAMJS_ZONE_ID,
              Name: roamjsDomain,
              Type: "A",
            },
          },
          Route53AAAARecordRoamJS: {
            Type: "AWS::Route53::RecordSet",
            Properties: {
              AliasTarget,
              HostedZoneId: process.env.ROAMJS_ZONE_ID,
              Name: roamjsDomain,
              Type: "AAAA",
            },
          },
          CloudwatchRule: {
            Type: "AWS::Events::Rule",
            Properties: {
              Description: `RoamJS Static Site Deploy for ${roamGraph}`,
              ScheduleExpression: "cron(0 4 ? * * *)",
              Name: `RoamJS-${roamGraph}`,
              RoleArn: process.env.CLOUDWATCH_ROLE_ARN,
              State: "ENABLED",
              Targets: [
                {
                  Id: "DeployLambda",
                  Input,
                  Arn: process.env.DEPLOY_LAMBDA_ARN,
                },
              ],
            },
          },
        },
      }),
    })
    .promise();

  await lambda
    .invoke({
      FunctionName: "RoamJS_deploy",
      InvocationType: "Event",
      Payload: JSON.stringify({
        roamGraph,
        domain,
      }),
    })
    .promise();

  return { success: true };
};
