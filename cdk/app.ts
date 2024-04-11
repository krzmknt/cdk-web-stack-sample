import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { WebStack } from "./webStack";

const app = new cdk.App();
new WebStack(app, "WebStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  dummyImage: app.node.tryGetContext("environment"),
});
