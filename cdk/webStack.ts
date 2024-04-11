import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";

interface WebStackProps extends cdk.StackProps {
  dummyImage: boolean;
}

export class WebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    /**
     * 構築時に初期作成する MySQL データベース名.
     *
     * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.DatabaseCluster.html#defaultdatabasename
     */
    const defaultDatabaseName = "mydb";

    /**
     * VPC (Virtual Private Cloud)
     *
     * (Public (for ALB) + Private (for ECS) + Private (for RDS) ) * 2 AZs のサブネット構成を作成.
     *
     * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.Vpc.html
     */
    const vpc: ec2.Vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 2, // デフォルトですべてのAZを使用するため２つに制限
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    /**
     * ECS Cluster
     *
     * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs.Cluster.html
     */
    const cluster = new ecs.Cluster(this, "EcsCluster", {
      vpc: vpc,
      containerInsights: true, // CloudWatch Container Insightsを有効化
    });

    /**
     * ECR Repostiroy
     *
     * destroy 時にリポジトリを削除するように指定.
     *
     * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecr.Repository.html
     */
    const ecrRepository = new ecr.Repository(this, "EcrRepository", {
      emptyOnDelete: true, // CDKスタック削除時にリポジトリ内のイメージも削除する
      removalPolicy: cdk.RemovalPolicy.DESTROY, // CDKスタック削除時にリポジトリも削除する(default: RETAIN)
    });

    /**
     * Aurora MySQL (Serverless v2)
     *
     * デフォルトでユーザー名 "admin" が作成される（パスワードは SecretsManager が自動生成）.
     * 認証情報は SecretsManager に保存される.
     *
     * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.DatabaseCluster.html
     */
    const auroraCluster = new rds.DatabaseCluster(this, "AuroraCluster", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_06_0,
      }),
      cloudwatchLogsExports: ["audit", "error", "general", "slowquery"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      defaultDatabaseName,

      writer: rds.ClusterInstance.serverlessV2("Writer", {}),

      // readers: [
      //   rds.ClusterInstance.serverlessV2("Reader", {
      //     scaleWithWriter: true,
      //   }),
      // ],

      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      vpc,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });

    /**
     * Security Group (for ECS Service)
     *
     * RDS のインバウンドルールで ECS セキュリティグループを許可するため明示作成する.
     *
     * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.SecurityGroup.html
     */
    const ecsSecurityGroup = new ec2.SecurityGroup(this, "EcsSecurityGroup", {
      vpc,
      allowAllOutbound: true, // Allows the ECS tasks to initiate connections to the RDS instance
    });

    /**
     * ECS TaskRole
     *
     * サンプルとして管理者権限を付与.
     *
     * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_iam.Role.html
     */
    const taskRole = new iam.Role(this, "EcsTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess")
    );

    /**
     * Internet-facing ALB and ECS Service (+ Task definition &z Container definition)
     *
     * インター向けのALB,  private Fargate サービスを作成.
     *
     * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService.html
     */
    const loadBalancedFargateService =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        "FargateService",
        {
          cluster,
          cpu: 256,
          memoryLimitMiB: 512,
          desiredCount: 1,
          publicLoadBalancer: true,
          healthCheckGracePeriod: cdk.Duration.seconds(300), // 5分間ヘルスチェックの結果を無視する
          securityGroups: [ecsSecurityGroup],

          runtimePlatform: {
            // cpuArchitecture: ecs.CpuArchitecture.X86_64,
            cpuArchitecture: ecs.CpuArchitecture.ARM64,
          },

          taskImageOptions: {
            taskRole,

            // ECR リポジトリからイメージを取得するか、ローカルの Dockerfile からビルドするかを指定
            image: props.dummyImage
              ? ecs.ContainerImage.fromAsset("./app/dummy/daemon/")
              : ecs.ContainerImage.fromEcrRepository(ecrRepository, "latest"),

            containerPort: 80, // アプリケーションは 80 ポートでリッスンする

            // コンテナ環境変数に設定
            environment: {
              DB_HOST: auroraCluster.clusterEndpoint.hostname,
              DB_PORT: auroraCluster.clusterEndpoint.port.toString(),
              DB_NAME: defaultDatabaseName,
            },

            // SecretsManager から認証情報を取得してコンテナ環境変数に設定
            secrets: {
              DB_USER: ecs.Secret.fromSecretsManager(
                auroraCluster.secret!,
                "username"
              ),
              DB_PASS: ecs.Secret.fromSecretsManager(
                auroraCluster.secret!,
                "password"
              ),
            },
          },
        }
      );

    auroraCluster.connections.allowFrom(ecsSecurityGroup, ec2.Port.tcp(3306));
  }
}
