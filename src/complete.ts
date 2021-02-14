import AWS from "aws-sdk";
import { SNSEvent } from "aws-lambda";
import { createLogStatus, ZONE_COMMENT_PREFIX } from "./common";

const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

const ses = new AWS.SES({ apiVersion: "2010-12-01" });
const cf = new AWS.CloudFormation({ apiVersion: "2010-05-15", credentials });
const route53 = new AWS.Route53({ apiVersion: "2013-04-01", credentials });
const ACM_START_TEXT = "Content of DNS Record is: ";

const getHostedZone = async (domain: string) => {
  let finished = false;
  let Marker: string = undefined;
  while (!finished) {
    const {
      HostedZones,
      IsTruncated,
      NextMarker,
    } = await route53.listHostedZones({ Marker }).promise();
    const zone = HostedZones.find((i) => i.Name === `${domain}.`);
    if (zone) {
      return zone;
    }
    finished = !IsTruncated;
    Marker = NextMarker;
  }
  return undefined;
};

export const handler = async (event: SNSEvent) => {
  const message = event.Records[0].Sns.Message;
  const messageObject = Object.fromEntries(
    message
      .split("\n")
      .map((l) => l.split("="))
      .map(([key, value]) => [
        key,
        value && value.substring(1, value.length - 1),
      ])
  );
  const {
    StackName,
    LogicalResourceId,
    ResourceStatus,
    StatusReason,
  } = messageObject;
  const roamGraph = StackName.match("roamjs-(.*)")[1];
  const logStatus = createLogStatus(roamGraph);

  if (LogicalResourceId === StackName && ResourceStatus === "CREATE_COMPLETE") {
    const summaries = await cf
      .listStackResources({ StackName })
      .promise()
      .then((r) => r.StackResourceSummaries);
    const roamjsDomain = summaries.find(
      (s) => s.LogicalResourceId === "Route53ARecordRoamJS"
    ).PhysicalResourceId;
    const domain = summaries.find(
      (s) => s.LogicalResourceId === "Route53ARecord"
    ).PhysicalResourceId;

    const zone = await getHostedZone(domain);
    await logStatus("LIVE");

    if (zone) {
      const email = zone.Config.Comment.substring(ZONE_COMMENT_PREFIX.length);
      await ses
        .sendEmail({
          Destination: {
            ToAddresses: [email],
          },
          Message: {
            Body: {
              Text: {
                Charset: "UTF-8",
                Data: `Your static site is live and accessible at ${roamjsDomain}. Follow instructions below to make your site accessible from your custom domain, ${domain}.`,
              },
            },
            Subject: {
              Charset: "UTF-8",
              Data: `Your RoamJS site is now live!`,
            },
          },
          Source: "support@roamjs.com",
        })
        .promise();
    }
  } else if (StatusReason.startsWith(ACM_START_TEXT)) {
    console.log("ACM!!!", JSON.stringify(messageObject, null, 4));
    const summaries = await cf
      .listStackResources({ StackName })
      .promise()
      .then((r) => r.StackResourceSummaries);
    const domain = summaries.find(
      (s) => s.LogicalResourceId === "Route53ARecord"
    ).PhysicalResourceId;
    const zone = await getHostedZone(domain);
    if (zone) {
      const sets = await route53
        .listResourceRecordSets({ HostedZoneId: zone.Id })
        .promise();
      const set = sets.ResourceRecordSets.find((r) => r.Type === "NS");
      const ns = set.ResourceRecords.map((r) => r.Value);
      logStatus("AWAITING VALIDATION", JSON.stringify(ns));
    }
  } else {
    console.log(
      "I would like to log some of these",
      JSON.stringify(messageObject, null, 4)
    );
  }
};
